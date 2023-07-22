import {
  compareVersion, getScriptName, getScriptUpdateUrl, i18n, sendCmd, trueJoin,
} from '@/common';
import { METABLOCK_RE } from '@/common/consts';
import { fetchResources, getScriptById, getScripts, notifyToOpenScripts, parseScript } from './db';
import { parseMeta } from './script';
import { getOption, setOption } from './options';
import { addOwnCommands } from './message';
import { requestNewer } from './storage-fetch';

const processes = {};

addOwnCommands({
  /**
   * @param {number} [id] - when omitted, all scripts are checked
   * @return {Promise<number>} number of updated scripts
   */
    async CheckUpdate(id) {
    const scripts = id ? [getScriptById(id)] : getScripts();
    const parallel = 2;
    const mapOfPools = new Map();
    /**
     * @param {string} [hostname] - hostname
     * @return {Array<Object|number>} pools
     */
    const getPoolsByHostname = (hostname) => {
      let res = mapOfPools.get(hostname)
      if (!res) {
        res = [[]];
        mapOfPools.set(hostname, res);
      }
      return res;
    }
    /**
     * @param {string} [urlLike] - downloadURL
     * @return {string} hostname of downloadURL
     */
    const getHostname = (urlLike) => {
      let res = '';
      try {
        res = new URL(urlLike).hostname;
      } catch (e) { }
      return res || '';
    }
    for (const script of scripts) {
      const curId = script.props.id;
      const urls = getScriptUpdateUrl(script, true);
      const downloadURL = urls ? urls[0] : '';
      const downloadURLHost = getHostname(downloadURL) || 'default';
      const pools = getPoolsByHostname(downloadURLHost)
      let pool = pools[pools.length - 1];
      if (urls && (id || script.config.enabled || !getOption('updateEnabledScriptsOnly'))) {
        pool.push({ curId, script, urls });
        if (pool.length >= parallel) {
          pool = [];
          pools.push(pool);
        }
      }
    }
    const results = [];
    const promisesPerSite = [];
    mapOfPools.forEach(pools => {
      promisesPerSite.push(new Promise(resolve => {
        const resultsOfSite = [];
        for (const pool of pools) {
          if (pool.length === 0) break;
          const promiseOfPool = pool.map(entry => {
            let { curId, script, urls } = entry;
            return processes[curId] || (processes[curId] = doCheckUpdate(script, urls));
          });
          const poolResult = await Promise.all(promiseOfPool); // poolResult = [r x N]; max{N} = parallel
          resultsOfSite.push.apply(resultsOfSite, poolResult); // resultsOfSite = [r x M]
        }
        resolve(resultsOfSite); // all the results of a site
      }));
    });
    const resultsPerSite = await Promise.all(promisesPerSite); // resultsPerSite = [ [r x M] x SiteN ]
    for (const resultsOfSite of resultsPerSite) {
      results.push.apply(results, resultsOfSite); // [r x K]
    }
    const notes = results.filter(r => r?.text);
    if (notes.length) {
      notifyToOpenScripts(
        notes.some(n => n.err) ? i18n('msgOpenUpdateErrors') : i18n('optionUpdate'),
        notes.map(n => `* ${n.text}\n`).join(''),
        notes.map(n => n.script.props.id),
      );
    }
    if (!id) setOption('lastUpdate', Date.now());
    return results.reduce((num, r) => num + (r === true), 0);
  },
});

async function doCheckUpdate(script, urls) {
  const { id } = script.props;
  let res;
  let msgOk;
  let msgErr;
  let resourceOpts;
  try {
    const { update } = await parseScript({
      id,
      code: await downloadUpdate(script, urls),
      update: { checking: false },
    });
    msgOk = i18n('msgScriptUpdated', [getScriptName(update)]);
    resourceOpts = { cache: 'no-cache' };
    res = true;
  } catch (update) {
    msgErr = update.error;
    // Either proceed with normal fetch on no-update or skip it altogether on error
    resourceOpts = !update.error && !update.checking && {};
    if (process.env.DEBUG) console.error(update);
  } finally {
    if (resourceOpts) {
      msgErr = await fetchResources(script, null, resourceOpts);
      if (process.env.DEBUG && msgErr) console.error(msgErr);
    }
    if (canNotify(script) && (msgOk || msgErr)) {
      res = {
        script,
        text: [msgOk, msgErr]:: trueJoin('\n'),
        err: !!msgErr,
      };
    }
    delete processes[id];
  }
  return res;
}

async function downloadUpdate(script, urls) {
  let errorMessage;
  const { meta, props: { id } } = script;
  const [downloadURL, updateURL] = urls;
  const update = {};
  const result = { update, where: { id } };
  announce(i18n('msgCheckingForUpdate'));
  try {
    const { data } = await requestNewer(updateURL, {
      cache: 'no-cache',
      // Smart servers like OUJS send a subset of the metablock without code
      headers: { Accept: 'text/x-userscript-meta,*/*' },
    }) || {};
    const { version } = data ? parseMeta(data) : {};
    if (compareVersion(meta.version, version) >= 0) {
      announce(i18n('msgNoUpdate'), { checking: false });
    } else if (!downloadURL) {
      announce(i18n('msgNewVersion'), { checking: false });
    } else if (downloadURL === updateURL && data?.replace(METABLOCK_RE, '').trim()) {
      // Code is present, so this is not a smart server, hence the response is the entire script
      announce(i18n('msgUpdated'));
      return data;
    } else {
      announce(i18n('msgUpdating'));
      errorMessage = i18n('msgErrorFetchingScript');
      return (await requestNewer(downloadURL, { cache: 'no-cache' })).data;
    }
  } catch (error) {
    if (process.env.DEBUG) console.error(error);
    announce(errorMessage || i18n('msgErrorFetchingUpdateInfo'), { error });
  }
  throw update;
  function announce(message, { error, checking = !error } = {}) {
    Object.assign(update, {
      message,
      checking,
      error: error ? `${i18n('genericError')} ${error.status}, ${error.url}` : null,
      // `null` is transferable in Chrome unlike `undefined`
    });
    sendCmd('UpdateScript', result);
  }
}

function canNotify(script) {
  const allowed = getOption('notifyUpdates');
  return getOption('notifyUpdatesGlobal')
    ? allowed
    : script.config.notifyUpdates ?? allowed;
}


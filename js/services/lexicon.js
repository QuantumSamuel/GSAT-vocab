import { loadWords } from './vocab.js';

const manifestCache = new Map();
const sliceCache = new Map();
const pending = new Map();
let indexedWords=null, wordsById=null;

async function fetchJson(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`載入 ${url} 失敗（HTTP ${res.status}）`);
  return res.json();
}

export async function loadLexiconManifest() {
  if (manifestCache.has('manifest')) return manifestCache.get('manifest');
  if (!pending.has('manifest')) {
    pending.set('manifest', fetchJson('data/lexicon/manifest.json')
      .then((data) => {
        if(data?.format!=='lexicon-sidecar-manifest-v1'||!Number.isInteger(data.wordCount)||!Array.isArray(data.slices))throw Error('詞庫來源資料格式錯誤');
        manifestCache.set('manifest', data);
        return data;
      })
      .finally(() => pending.delete('manifest')));
  }
  return pending.get('manifest');
}

export async function loadLexiconSlice(detailKey) {
  const key = String(detailKey || '');
  if (!key) return null;
  if(!/^slice-\d{4}\.json$/.test(key))throw Error('詞庫分片名稱無效');
  if (sliceCache.has(key)) return sliceCache.get(key);
  if (!pending.has(key)) {
    pending.set(key, fetchJson(`data/lexicon/${key}`)
      .then((data) => {
        if(data?.format!=='lexicon-sidecar-slice-v1'||data.slice!==key||!Array.isArray(data.entries))throw Error('詞庫詳情資料格式錯誤');
        sliceCache.set(key, data);
        return data;
      })
      .finally(() => pending.delete(key)));
  }
  return pending.get(key);
}

export async function loadLexiconEntry(wordId, opts = {}) {
  const { word = null } = opts;
  const id = String(wordId);
  let entry;
  if(word)entry=String(word.id)===id?word:null;
  else{
    const words=await loadWords();
    if(words!==indexedWords){indexedWords=words;wordsById=new Map(words.map(w=>[String(w.id),w]));}
    entry=wordsById.get(id);
  }
  if (!entry) return null;
  const detailKey = entry.detailKey;
  if (!detailKey) return null;
  const slice = await loadLexiconSlice(detailKey);
  const match = slice?.entries?.find((item) => String(item.id) === id);
  if (!match) return null;
  return { ...match, detailKey, commit: slice.commit };
}

export async function loadLexiconCoverage() {
  const manifest = await loadLexiconManifest();
  return manifest.coverage ?? {};
}

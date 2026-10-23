// 新來源只作可展開的補充；不替換既有中文釋義或將未對義同義詞冒稱已審。
import {escapeHtml} from './ui.js';
const lines=value=>String(value||'').replaceAll('\\n','\n').split('\n').filter(Boolean);
export function lexiconDetailsHtml(entry){
  const rows=entry?.sourceMatches||[];
  const forms={p:'過去式',d:'過去分詞',i:'現在分詞','3':'第三人稱單數',r:'比較級',t:'最高級',s:'複數','0':'原形'};
  const dictionaries=rows.map(m=>{
    const raw=m.raw||{};
    const definition=lines(raw.definition).map(x=>`<div class="dict-row">${escapeHtml(x)}</div>`).join('');
    const exchange=String(raw.exchange||'').split('/').map(part=>{
      const at=part.indexOf(':');if(at<0||!forms[part.slice(0,at)])return '';
      return `<span>${escapeHtml(forms[part.slice(0,at)])}：${escapeHtml(part.slice(at+1))}</span>`;
    }).filter(Boolean).join('；');
    const tags=[raw.tag&&`標記 ${raw.tag}`,Number(raw.collins)>0&&`Collins ${raw.collins}`,raw.oxford==='1'&&'Oxford 3000',Number(raw.bnc)>0&&`BNC ${raw.bnc}`,Number(raw.frq)>0&&`詞頻 ${raw.frq}`].filter(Boolean);
    return `<section><p><strong>${escapeHtml(m.headword)}</strong></p>${definition||'<p class="muted">此來源沒有英文釋義。</p>'}${exchange?`<p>${exchange}</p>`:''}${tags.length?`<p class="tp-caption">${escapeHtml(tags.join('；'))}</p>`:''}</section>`;
  }).join('');
  const pronunciations=(entry?.pronunciations||[]).map(p=>`<p>${escapeHtml(p.word)}：美式 /${escapeHtml(p.ipa)}/</p>`).join('');
  const synonyms=(entry?.unmappedSynonyms||[]).map(s=>escapeHtml(s.word)).join('、');
  return `<p class="tp-caption">來源：<a href="https://github.com/skywind3000/ECDICT" target="_blank" rel="noopener noreferrer">ECDICT（MIT）</a>；美式音標：ipa-dict en_US（MIT）。來源與釋義仍可能有缺漏。</p>${pronunciations||'<p class="muted">此字尚無可確認的美式音標。</p>'}${dictionaries||'<p class="muted">未找到可確認的詞典條目。</p>'}${synonyms?`<p>同義參考（尚未對應詞義）：${synonyms}</p>`:''}`;
}

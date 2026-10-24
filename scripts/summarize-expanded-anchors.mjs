// Supplemental endpoint checks, not forced-aligned word latency.
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const root = process.cwd();
const { benchmarkWords } = await import(pathToFileURL(`${root}/src/speech-benchmark.js`));
const summary = JSON.parse(await readFile('benchmarks/window-study-expanded-results.json'));
const manifest = JSON.parse(await readFile(summary.manifest));
const median = values => { const s = values.toSorted((a,b)=>a-b), i=Math.floor(s.length/2); return s.length ? s.length%2 ? s[i] : (s[i-1]+s[i])/2 : null; };
const contains = (words, phrase) => words.some((_, i) => phrase.every((word, j) => words[i+j] === word));
const occurrences = (words, phrase) => words.reduce((n,_,i)=>n+Number(phrase.every((word,j)=>words[i+j]===word)),0);
for (const row of summary.rows) {
 if(row.failed) continue;
 const report=JSON.parse(await readFile(row.raw)), run=report.runs[0], sample=manifest.cases.find(c=>c.id===row.id);
 const ref=benchmarkWords(run.expected), final=benchmarkWords(run.text), updates=run.updates.map(u=>({...u,words:benchmarkWords(u.text)}));
 let end=0;
 row.sentenceTails=sample.samples.map(clip=>{
  end+=clip.seconds; const phrase=benchmarkWords(clip.reference).slice(-3), eligible=phrase.length===3&&occurrences(ref,phrase)===1;
  if(!eligible) return { id:clip.id,eligible:false };
  const flags=updates.map(u=>contains(u.words,phrase)), first=flags.indexOf(true), lastAbsent=flags.lastIndexOf(false), survives=contains(final,phrase);
  return { id:clip.id,eligible:true,phrase:phrase.join(' '),clipEndSeconds:end,everSeen:first>=0,final:survives,
   firstDelaySeconds:first<0?null:updates[first].ms/1000-end,
   stableDelaySeconds:!survives?null:updates[lastAbsent+1]?.ms/1000-end };
 });
 row.actualWindows={ calls:run.calls.length, fullWindowCalls:run.calls.filter(c=>Math.abs(c.seconds-row.windowSeconds)<.001).map(c=>({start:c.start,end:c.end,tokens:c.segments[0].tokens,tokenLimit:c.segments[0].tokenLimit})),
  everyRequestOneModelPass:run.calls.every(c=>c.segments.length===1&&Math.abs(c.seconds-c.segments[0].seconds)<.001) };
}
for(const aggregate of summary.aggregates){
 const rows=summary.rows.filter(r=>!r.repeat&&!r.failed&&r.windowSeconds===aggregate.windowSeconds), tails=rows.flatMap(r=>r.sentenceTails.filter(t=>t.eligible));
 aggregate.sentenceTails={eligible:tails.length,everSeen:tails.filter(t=>t.everSeen).length,final:tails.filter(t=>t.final).length,
 medianFirstDelaySeconds:median(tails.filter(t=>t.everSeen).map(t=>t.firstDelaySeconds)),medianStableDelaySeconds:median(tails.filter(t=>t.final&&t.stableDelaySeconds!==null).map(t=>t.stableDelaySeconds)),
 maxFirstDelaySeconds:Math.max(...tails.filter(t=>t.everSeen).map(t=>t.firstDelaySeconds))};
}
summary.notes.push('Sentence-tail checks match unique final three-word reference phrases against visible updates. Times are relative to clip endpoints (including silence), not forced-aligned word timings; only recognized anchors contribute delays. Stable delay is the first appearance after the last disappearance, for anchors retained at finish.');
await writeFile('benchmarks/window-study-expanded-results.json',JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify(summary.aggregates.map(a=>({windowSeconds:a.windowSeconds,sentenceTails:a.sentenceTails})),null,2));

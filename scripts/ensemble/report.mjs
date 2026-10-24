import {readFile,writeFile} from 'node:fs/promises';
import {correctionChanges} from '../../src/speech-benchmark.js';
const result=JSON.parse(await readFile('benchmarks/ensemble-results.json'));
if(!result.completeSweep)throw Error('The full 780-configuration accuracy sweep is not complete');
const audit=JSON.parse(await readFile('benchmarks/ensemble-audit.json'));
if(audit.incomplete.length||audit.rows.length!==120)throw Error('Incomplete audit');
const streams=JSON.parse(await readFile('benchmarks/ensemble-streams.json'));
const raw=JSON.parse(await readFile('test-results/ensemble-analysis.json'));
const names={'moonshine-tiny':'Moonshine Tiny (current)','moonshine-base':'Moonshine Base','whisper-tiny.en':'Whisper Tiny English','whisper-base.en':'Whisper Base English','conformer-small':'Conformer CTC Small','zipformer-20m':'Zipformer 20M','vosk-small':'Vosk Small English','moonshine-tiny-streaming':'Moonshine Tiny Streaming'};
const summary=new Map(result.summaries.map(s=>[s.name,s]));
const pct=s=>s?(s.wer*100).toFixed(2)+'%':'unsupported';
const individual=(m,w=15,hints=true)=>summary.get(`${m}/${w}/0/${hints?'hints':'plain'}`);
const best=result.summaries.find(s=>s.kind==='cross-model');
const members=result.trials.find(t=>t.name===best.name).members;
const plain=best.name.includes('-plain:');
const strongest=members.map(m=>individual(m,15,!plain)).sort((a,b)=>a.wer-b.wer)[0];
const baseline=individual('moonshine-tiny');
const bestSingle=result.summaries.find(s=>s.kind==='individual');
function compare(a,b){const aa=raw.trials.filter(t=>t.name===a.name),bb=raw.trials.filter(t=>t.name===b.name);let wins=0,ties=0,losses=0,fixed=0,introduced=0;
 for(const t of aa){const u=bb.find(x=>x.case===t.case),d=t.score.errors-u.score.errors,c=correctionChanges(u.score,t.score);if(d<0)wins++;else if(d>0)losses++;else ties++;fixed+=c.fixed;introduced+=c.introduced;}
 return{candidate:a.name,baseline:b.name,wins,ties,losses,fixed,introduced,errorReductionPercent:(b.errors-a.errors)/b.errors*100};}
const comparisons=[compare(best,baseline),compare(best,strongest),compare(best,bestSingle)];
const metadata=new Map(result.trials.map(t=>[t.name,t]));
const cardinality=Array.from({length:7},(_,i)=>{
 const size=i+2,candidates=result.summaries.filter(s=>s.kind==='cross-model'&&metadata.get(s.name).members.length===size);
 return{size,subsets:[28,56,70,56,28,8,1][i],best:candidates[0],members:metadata.get(candidates[0].name).members,
  conditions:['raw:','calibrated:','raw-plain:','calibrated-plain:'].map(prefix=>({prefix,best:candidates.find(s=>s.name.startsWith(prefix))}))};
});
const trioBaseline=summary.get('calibrated:conformer-small+zipformer-20m+moonshine-base');
const windowRows=result.summaries.filter(s=>s.kind==='top-three-windows');
const bestTrioWindows=windowRows[0];
const trioWindowComparisons=windowRows.map(s=>compare(s,trioBaseline));
const condition=s=>`${s.name.startsWith('raw')?'raw':'calibrated'} confidence, ${s.name.includes('-plain:')?'no hints':'hints'}`;
const lines=['## Measured results (2026-10-13)','',
 `All **120 model/passage combinations and 780 supported window/hint configurations** completed. ${audit.rows.reduce((n,r)=>n+r.calls,0).toLocaleString()} successful recognizer calls include ${audit.rows.reduce((n,r)=>n+r.fallbackCalls,0).toLocaleString()} new-audio seam fallbacks. Every row below uses the same 15 passages and 4,311 reference words. WER includes substitutions, deletions and insertions; lower is better.`,
 '', '| Model | 15 s, no hints | 15 s, hints | 30 s, hints | 60 s, hints |', '| --- | ---: | ---: | ---: | ---: |'];
for(const [model,name]of Object.entries(names))lines.push(`| ${name} | ${pct(individual(model,15,false))} | ${pct(individual(model))} | ${pct(individual(model,30))} | ${pct(individual(model,60))} |`);
lines.push('', 'These are the unshifted grids. The full results also retain quarter-window shifts. Conformer and Vosk have no soft-hint path in these adapters, so their two 15-second columns are controls with identical settings. Vosk’s one-word difference is run variation, not evidence of hint support. A 60-second input to a streaming architecture can still be internally segmented.', '',
 `The lowest observed cross-model ensemble is **${best.name}**, ${best.errors} errors / **${pct(best)}**. Its strongest individual member in the matching setup is ${strongest.name}, ${strongest.errors} errors / ${pct(strongest)}. The best single-model configuration across all tested sizes/shifts is ${bestSingle.name}, ${bestSingle.errors} errors / ${pct(bestSingle)}.`, '',
 '| Selected ensemble compared with | Fewer-error passages | Ties | More-error passages | Errors fixed | Errors introduced | Relative error reduction |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
for(const c of comparisons)lines.push(`| ${c.baseline} | ${c.wins} | ${c.ties} | ${c.losses} | ${c.fixed} | ${c.introduced} | ${c.errorReductionPercent.toFixed(1)}% |`);
lines.push('', 'Confidence calibration holds out each speaker in turn. Selection of the best ensemble/window combination still uses this same small corpus: these are exploratory results, not an independently confirmed winner.', '', 'Selected confidence-weighted ensemble results:', '', '| Combination | WER | Errors |', '| --- | ---: | ---: |');
const bestPair=result.summaries.find(s=>s.kind==='cross-model'&&result.trials.find(t=>t.name===s.name).members.length===2);
const selections=[best,bestPair,...['moonshine-tiny','conformer-small'].map(m=>result.summaries.find(s=>s.kind==='same-model-windows'&&s.name.includes(':'+m+':'))),...result.summaries.filter(s=>s.kind==='cross-model-windows')];
for(const s of selections)lines.push(`| ${s.name} | ${pct(s)} | ${s.errors} |`);
lines.push('', '### More than three models', '',
 'Scored every one of the 247 subsets of two through eight models, under both raw/calibrated confidence and hinted/unhinted controls. These use the same unshifted 15-second outputs; no new recognizer runs were required. The table selects the best condition and subset at each size, so it measures the best observed result rather than a controlled causal effect of adding one model.', '',
 '| Models | Subsets tested | Best observed members | Confidence / hints | WER | Errors |', '| ---: | ---: | --- | --- | ---: | ---: |');
for(const row of cardinality)lines.push(`| ${row.size} | ${row.subsets} | ${row.size===8?'All eight':row.members.map(m=>names[m]).join(' + ')} | ${condition(row.best)} | ${pct(row.best)} | ${row.best.errors} |`);
lines.push('', 'All-eight controls:', '', '| Confidence / hints | WER | Errors |', '| --- | ---: | ---: |');
for(const row of cardinality.at(-1).conditions)lines.push(`| ${condition(row.best)} | ${pct(row.best)} | ${row.best.errors} |`);
lines.push('', '### Original best trio with multiple windows', '',
 'Fixed members: Conformer CTC Small + Zipformer 20M + Moonshine Base, selected in the original study. All rows here use vocabulary hints where supported and give each model the same total voting weight, divided equally among its window grids. Original grids start at zero; shifted grids start one quarter-window later. Both use half-window overlap. A grid produces one finalized transcript per model; it is not a single audio window. These are votes over complete saved transcripts, not simultaneous streaming-ensemble timing tests.', '',
 '| Window grids per model | Hypotheses total | Raw-confidence WER | Calibrated WER | Calibrated errors |', '| --- | ---: | ---: | ---: | ---: |');
for(const label of ['15-original','15-shifted','15-both-grids','30-original','30-shifted','30-both-grids','60-original','60-shifted','60-both-grids','15+30','15+60','30+60','all-windows']){
 const r=summary.get(`raw:top-three:${label}`),c=summary.get(`calibrated:top-three:${label}`);
 lines.push(`| ${label} | ${metadata.get(c.name).gridsPerModel*3} | ${pct(r)} | ${pct(c)} | ${c.errors} |`);
}
const windowComparison=compare(bestTrioWindows,trioBaseline);
lines.push('', `The best observed trio/window result is **${bestTrioWindows.name}**, ${bestTrioWindows.errors} errors / **${pct(bestTrioWindows)}**, versus ${trioBaseline.errors} / ${pct(trioBaseline)} for the original calibrated 15-second trio. It has fewer errors on ${windowComparison.wins} passages, ties on ${windowComparison.ties}, and more errors on ${windowComparison.losses}; it fixes ${windowComparison.fixed} reference-aligned errors and introduces ${windowComparison.introduced}. Extra grids require extra decoding work; combined runtime, memory, power and streaming churn were not measured.`, '',
 `Expanded scoring contains ${result.summaries.length.toLocaleString()} summaries and ${result.trials.length.toLocaleString()} passage/configuration results. Selection across this larger search further increases optimism; all results still need independent confirmation. [Cardinality and window comparisons](../benchmarks/ensemble-cardinality.json) retain every condition winner and paired comparison.`);
lines.push('', '### Proposed display quorum (not yet measured)', '',
 'The user asked whether displaying only majority-agreed words could reduce wrong intermediate text. Current voting selects the confidence-weighted winner; it does not require a strict majority of independent models. A possible live policy requires two of three models to agree before displaying each aligned word, uses confidence within disagreements, and counts multiple windows from the same model as one model. Buffer unresolved regions rather than silently deleting words or joining separated fragments. At release, resolve the remaining region with weighted voting and mark uncertainty; strict withholding without a fallback can omit correct names and other difficult words.', '',
 'Agreement is not proof of correctness: models can share errors and revise a former majority. A small stability delay may help but adds latency. The saved paced traces do not contain per-update word confidences for every model, and the models were run independently rather than concurrently. No confidence-weighted live-quorum replay, phone latency measurement, or reduction in intermediate errors has been established in this follow-up. First-word latency, spoken-word lag, revisions, wrong-word exposure and missing words need a separate paced comparison before changing production display behavior.');
lines.push('', 'An eight-word phrase repeated at least four times, with at least three more occurrences than the reference, is flagged as major repetition. Final repetition counts and individual-passage scores are retained in the result JSON; temporary streaming revisions are measured separately.', '', '### Streaming responsiveness', '',
 `Paced checks use one representative ${streams.seconds.toFixed(1)}-second passage, warm models and real-time audio delivery. They are **desktop spot checks**, not 15-speaker latency distributions or iPhone measurements. The full accuracy sweep above uses native runtimes. Only the four Transformers.js models were also exercised in Chrome WASM. Concurrent ensemble latency was not measured.`, '',
 '| Model / window | Hints | Runtime | First visible word | After release | Final errors |', '| --- | --- | --- | ---: | ---: | ---: |');
for(const r of streams.rows){if(r.error)continue;lines.push(`| ${names[r.model]} / ${r.window} | ${['conformer-small','vosk-small'].includes(r.model)?'not supported':r.hints?'yes':'no'} | ${r.runtime.startsWith('Chrome')?'Chrome WASM':'native CPU'} | ${(r.firstWordMs/1000).toFixed(2)} s | ${(r.releaseMs/1000).toFixed(2)} s | ${r.finalErrors} |`);}
lines.push('', `Maximum capture-delivery lateness was ${Math.max(...streams.rows.map(r=>r.maxFeedLateMs||0)).toFixed(1)} ms. Decoder backlog, transcript revisions, recognized sentence-tail delays and missed anchors are retained in the streaming JSON. Incremental decoders' queue backlog is not equivalent to word-display latency. Tail checks use exact three-word anchors relative to source-clip endpoints, including silence; they are not forced-aligned word timestamps.`, '',
 '### Evidence and limitations', '',
 '- [Accuracy metrics and per-passage scores](../benchmarks/ensemble-results.json), [stream timing/anchor data](../benchmarks/ensemble-streams.json), [completion and confidence audit](../benchmarks/ensemble-audit.json).',
 '- Raw recognizer and ensemble transcripts are retained locally in `test-results/ensemble/`, `test-results/ensemble-merged/` and `test-results/ensemble-analysis.json`. Model/input hashes and pinned revisions are tracked separately.',
 '- The Whisper adapter initially allowed prompt plus generation to exceed its 448-token context, causing an ONNX reshape failure. Generation is now bounded by remaining context; the failed attempt is retained and its missing window retried. Sixty-second Whisper decoding remains unsupported.',
 '- Successful windows survive rescheduling. Checkpointed intermediate runs and interruption records are retained under `test-results/ensemble-attempts/repartition/`; no completed result was excluded because of poor accuracy.',
 '- The exact 15-second native/WASM smoke transcripts match for Moonshine Tiny/Base but differ for Whisper Tiny/Base. Thus native WER rankings are not established browser WER rankings; full browser/phone accuracy still needs confirmation.',
 '- Native runtimes, precision choices, vocabulary interfaces and internal segmentation differ. The new Moonshine runtime uses an isolated greedy-decoder telemetry patch; token probabilities are real, but the instrumentation adds work.',
 '- CPU affinity differs between runs: hinted Chrome checks used cores 15–16, no-hint Chrome controls 5–6, and native paced checks 11–12. Frequencies and other workloads were uncontrolled; timings are descriptive, not an isolated hint-overhead or cross-runtime speed comparison.',
 '- These public read-speech excerpts do not establish conversational dictation accuracy, phone memory/thermal cost, or the best independent-test ensemble. Pageborne and its installed STT package were not changed.', '');
const path='docs/ensemble-study.md',existing=await readFile(path,'utf8'),start='<!-- RESULTS START -->',end='<!-- RESULTS END -->';
const section=start+'\n'+lines.join('\n')+'\n'+end;
const next=existing.includes(start)?existing.slice(0,existing.indexOf(start))+section+existing.slice(existing.indexOf(end)+end.length):existing.replace('## Fixed protocol',section+'\n\n## Fixed protocol');
await writeFile(path,next);await writeFile('benchmarks/ensemble-comparisons.json',JSON.stringify({best:best.name,strongest:strongest.name,bestSingle:bestSingle.name,comparisons},null,2)+'\n');
await writeFile('benchmarks/ensemble-cardinality.json',JSON.stringify({cardinality,trioBaseline:trioBaseline.name,bestTrioWindows:bestTrioWindows.name,trioWindowComparisons},null,2)+'\n');
console.log(best.name,best.errors,pct(best));

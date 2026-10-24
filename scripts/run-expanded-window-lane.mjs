// Each lane runs serially on its externally assigned CPU pair. Rotate all
// window sizes across lanes to avoid confounding one configuration with a core.
import { readFile, writeFile, mkdir, open, rename } from 'node:fs/promises';
import { spawn } from 'node:child_process';
const arg = (key, fallback) => process.argv.find(v => v.startsWith(`--${key}=`))?.split('=')[1] || fallback;
const lane = Number(arg('lane', '0'));
if (![0, 1, 2].includes(lane)) throw new Error('Choose lane 0, 1 or 2');
const manifestPath = 'benchmarks/window-study-expanded-manifest.json';
const manifest = JSON.parse(await readFile(manifestPath));
if (manifest.cases.length !== 15 || new Set(manifest.cases.map(c => c.speaker)).size !== 15) throw new Error('Expected 15 different speakers');
const windows = [15, 30, 60];
const directory = 'test-results/window-expanded'; await mkdir(directory, { recursive: true });
const planned = [...manifest.cases.map((sample, i) => ({ sample, i, repeat: false })), ...[0, 7, 12].map((i, repeatIndex) => ({ sample: manifest.cases[i], i: 15 + repeatIndex, repeat: true }))];
const jobs = [];
for (const { sample, i, repeat } of planned) {
  const windowSeconds = windows[(i + lane) % 3];
  const label = `expanded-${sample.id}-${windowSeconds}${repeat ? '-repeat' : ''}`;
  const path = `test-results/window-study-chromium-${label}.json`;
  const job = { caseId: sample.id, windowSeconds, repeat, label, path, lane };
  jobs.push(job);
  let previous;
  try { previous = JSON.parse(await readFile(path)); }
  catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  if (previous?.completed && !previous.errors.length && previous.runs.length === 1 && previous.runs[0].metrics.timingValid) {
      job.status = 'resumed-complete'; console.log(`Already complete: ${label}`); continue;
  }
  // Preserve both artifacts, even when a terminated browser never wrote JSON.
  await mkdir(`${directory}/retries`, { recursive: true });
  const stamp = Date.now();
  for (const [source, extension] of [[path, 'json'], [`${directory}/${label}.log`, 'log']]) {
    try { await rename(source, `${directory}/retries/${label}-${stamp}.${extension}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  console.log(`Lane ${lane}: starting ${label} (${sample.seconds.toFixed(2)} seconds)`);
  const log = await open(`${directory}/${label}.log`, 'w');
  job.startedAt = new Date().toISOString();
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/window-study.mjs', `--manifest=${manifestPath}`, `--case=${sample.id}`, `--windows=${windowSeconds}`, '--policies=context', `--label=${label}`],
      { env: { ...process.env, STUDY_LANE: String(lane) }, stdio: ['ignore', log.fd, log.fd] });
    child.on('error', reject); child.on('exit', resolve);
  });
  await log.close();
  job.finishedAt = new Date().toISOString(); job.exitCode = code;
  try {
    const report = JSON.parse(await readFile(path));
    const run = report.runs[0];
    job.status = code === 0 && report.completed && run?.metrics.timingValid ? 'complete' : 'failed';
    job.summary = run ? { errors: run.score.errors, words: run.score.referenceWords, firstWordMs: run.metrics.firstWordMs,
      lag: run.metrics.backlogP95Seconds, releaseMs: run.metrics.releaseMs, timingValid: run.metrics.timingValid } : { errors: report.errors };
  } catch (error) { job.status = 'failed'; job.summary = { error: error.message }; }
  console.log(JSON.stringify(job));
  await writeFile(`${directory}/lane-${lane}.json`, JSON.stringify({ lane, jobs }, null, 2));
}
await writeFile(`${directory}/lane-${lane}.json`, JSON.stringify({ lane, jobs, completed: true }, null, 2));
console.log(`Lane ${lane} finished ${jobs.length} trials`);

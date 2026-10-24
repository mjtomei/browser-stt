import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const files = [...new Set(execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' }).split('\0').filter(Boolean))].filter(existsSync);
const problems = [];
for (const file of files) {
  const data = readFileSync(file);
  if (/(^|\/)(?:node_modules|dist|\.state|test-results|\.git)(\/|$)|\.tgz$|(^|\/)\.env(?:$|\.(?!example$))/.test(file)) problems.push(`${file}: generated/private file`);
  if (data.length > 100 * 1024 * 1024) problems.push(`${file}: too large for source publication`);
  // ONNX Runtime's upstream binary records its public GitHub Actions build root.
  // Normalize only that root: on Actions it happens to share the runner's home.
  const paths = data.toString('utf8').replaceAll('/home/runner/work/onnxruntime-build/onnxruntime-build/', '/upstream/onnxruntime/');
  if (paths.includes(homedir() + '/')) problems.push(`${file}: absolute home path`);
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(data.toString('utf8'))) problems.push(`${file}: private key material`);
}
for (const file of ['vendor/ensemble-runtime/SOURCES.md', 'vendor/ensemble-runtime/kissfft-BSD-3-Clause', 'vendor/stt/librispeech-LICENSE.txt', 'docs/THIRD-PARTY.md']) {
  if (!existsSync(file)) problems.push(`${file}: missing third-party notice`);
}
if (problems.length) { console.error(problems.join('\n')); process.exitCode = 1; }
else console.log(`Source audit passed: ${files.length} files; runtime and third-party notices checked.`);

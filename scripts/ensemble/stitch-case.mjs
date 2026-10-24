import{readFile}from'node:fs/promises';import{stitch}from'./stitch.mjs';
const r=JSON.parse(await readFile(process.argv[2]));const groups=[...new Map(r.windows.filter(w=>!w.fallback).map(w=>[`${w.window}/${w.shift}/${w.hints}`,{window:w.window,shift:w.shift,hints:w.hints}])).values()];
console.log(JSON.stringify(groups.flatMap(g=>stitch(r,g).missing)));

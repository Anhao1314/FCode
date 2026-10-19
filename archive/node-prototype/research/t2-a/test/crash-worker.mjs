import { readFile } from 'node:fs/promises';
import { BenchmarkExecutor } from '../executor.mjs';
import { STRATEGIES } from '../strategies.mjs';
const saved = JSON.parse(await readFile(process.argv[2], 'utf8'));
const executor = new BenchmarkExecutor(saved.root, { afterPhase: async phase => { if (phase === 'action-started') { process.send({ phase }); await new Promise(() => {}); } } });
await executor.run(saved.id, { principal: 't2-local-researcher' }, STRATEGIES.researchCandidate);

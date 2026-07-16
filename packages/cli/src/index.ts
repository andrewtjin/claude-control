// Public surface of the CLI package. `buildProgram` is exported for tests and embedding;
// the pure render/resolve/doctor helpers are exported so they can be reused and asserted.
export { buildProgram } from './program.js';
export { renderAccountsTable } from './render.js';
export { resolveAccountRef, type ResolveResult } from '@claude-control/switch-engine';
export { renderDoctor, summarize, runDoctor, type DoctorCheck } from './doctor.js';

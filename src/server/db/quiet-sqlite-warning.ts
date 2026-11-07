/**
 * node:sqlite prints an ExperimentalWarning on load. It is stable enough for our
 * use; silence only that one warning so the startup output stays clean.
 * Must be imported before node:sqlite.
 */
const original = process.emitWarning.bind(process)
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const msg = typeof warning === 'string' ? warning : warning?.message
  if (msg && msg.includes('SQLite is an experimental feature')) return
  return (original as (...a: unknown[]) => void)(warning, ...rest)
}) as typeof process.emitWarning

export {}

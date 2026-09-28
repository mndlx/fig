// Avvia insieme il server (API + login, porta 8787) e il frontend Vite (porta 5174).
// Ctrl+C li chiude entrambi.
import { spawn } from 'node:child_process'

const procs = [
  spawn('npm', ['--prefix', 'server', 'run', 'dev'], { stdio: 'inherit', shell: true }),
  spawn('npx', ['vite'], { stdio: 'inherit', shell: true }),
]

function stop(code = 0) {
  for (const p of procs) if (!p.killed) p.kill()
  process.exit(code)
}

for (const p of procs) p.on('exit', (code) => stop(code ?? 0))
process.on('SIGINT', () => stop(0))
process.on('SIGTERM', () => stop(0))

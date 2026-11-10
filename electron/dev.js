// Start Vite, wait for it, then launch Electron.
const { spawn } = require('child_process');
const http = require('http');

const vite = spawn('npx', ['vite', '--port', '5173'], { cwd: __dirname + '/..', stdio: 'inherit' });

function waitForVite(tries = 0) {
  http.get('http://localhost:5173', (res) => {
    res.resume();
    const args = process.getuid && process.getuid() === 0 ? ['--no-sandbox'] : [];
    const electron = spawn('npx', ['electron', 'electron-dist/main.js', ...args], {
      cwd: __dirname + '/..',
      env: { ...process.env, NODE_ENV: 'development' },
      stdio: 'inherit',
    });
    electron.on('exit', () => {
      vite.kill();
      process.exit(0);
    });
  }).on('error', () => {
    if (tries > 60) {
      console.error('Vite did not start');
      vite.kill();
      process.exit(1);
    }
    setTimeout(() => waitForVite(tries + 1), 500);
  });
}

setTimeout(waitForVite, 1000);

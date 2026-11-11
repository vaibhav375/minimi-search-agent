// Runs before `npm run dev`: node:sqlite (used for memory) needs Node 22.13 or newer.
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`This project needs Node.js 22.13 or newer (found ${process.versions.node}). Install the current LTS from https://nodejs.org`);
  process.exit(1);
}

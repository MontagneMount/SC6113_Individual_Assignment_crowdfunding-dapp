// Copies the ethers.js browser build into public/vendor/ethers/, where the Flask server
// serves it to the pages. Run after upgrading ethers: npm run vendor:ethers
import fs from "node:fs";

const target = "public/vendor/ethers";
fs.mkdirSync(target, { recursive: true });
fs.copyFileSync("node_modules/ethers/dist/ethers.min.js", `${target}/ethers.min.js`);
fs.copyFileSync("node_modules/ethers/LICENSE.md", `${target}/LICENSE.md`);

const { version } = JSON.parse(fs.readFileSync("node_modules/ethers/package.json", "utf8"));
console.log(`Copied ethers ${version} to ${target}/`);

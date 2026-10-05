# CampusFund: Campus Crowdfunding DApp

An all-or-nothing crowdfunding DApp for campus projects (SC6113 individual assignment).
Creators raise Sepolia ETH before a deadline. If the goal is met, the creator withdraws the funds once; otherwise every backer reclaims their own contribution. Every rule about money is enforced by a Solidity smart contract.

## Features

| Page | What you can do |
|---|---|
| Explore (`/`) | Browse, search and filter campaigns; platform statistics |
| Campaign (`/campaign.html?id=…`) | Back a campaign, withdraw (creator) or claim a refund (backer); fund transparency panel, backers and on-chain activity with Etherscan links; numbers are re-read from the contract and marked "Verified on-chain" |
| Start a campaign (`/create.html`) | Create a campaign on-chain, then sign its description and cover image |
| My activity (`/me.html`) | Personal statistics, campaigns backed and created, refunds or withdrawals waiting for you |
| Deploy (`/deploy.html`, local only) | Deploy the contract to Sepolia with MetaMask |

Works on phones: the layout is mobile first, and phone browsers without MetaMask get an "Open in MetaMask app" link.

## Architecture

```
Browser (HTML/CSS/JS + ethers.js)
 |-- MetaMask signs transactions --> Crowdfunding contract (Sepolia)
 |                                            | events
 |                                            v
 `-- REST API (search, history,  --> Express server --> MongoDB Atlas
     details, images)                 (indexer copies contract events)
```

- **The blockchain is the source of truth.** Balances, contributions and refund rights live only in the contract. MongoDB holds a rebuildable copy of the events (for fast search and history) plus off-chain details: descriptions, categories and cover images.
- **Private keys never leave MetaMask.** The server never signs anything. Even the contract is deployed from MetaMask.

## Tech stack

| Layer | Technology |
|---|---|
| Smart contract | Solidity 0.8.28, OpenZeppelin Contracts 5 (`ReentrancyGuard`, `SafeCast`) |
| Contract tooling and tests | Hardhat 3, Mocha, Chai, ethers.js v6 |
| Frontend | HTML, CSS, JavaScript (ES modules), ethers.js v6, MetaMask |
| Backend | Node.js, Express 5, Multer (uploads), MongoDB Node.js driver |
| Database | MongoDB Atlas (free tier) |
| Network | Ethereum Sepolia testnet |
| Hosting | Render (web service) |

## Funding rules (enforced by the contract)

1. The goal and deadline are fixed when a campaign is created (deadline 1 minute to 90 days ahead).
2. Contributions are accepted only before the deadline, even after the goal is reached. The creator cannot withdraw early.
3. After the deadline, if the goal is met, only the creator can withdraw, and only once.
4. After the deadline, if the goal is missed, each backer refunds their own contribution.
5. Repeated contributions add up; a refund can be claimed only once.
6. The creator cannot back their own campaign (prevents self-funding to fake success).

## Security highlights

- Contract: re-entrancy guard plus Checks-Effects-Interactions, pull-based refunds, custom errors, `SafeCast`, no `receive()` (plain ETH transfers are rejected).
- Campaign details can only be saved with a MetaMask signature from the on-chain creator. The signed message covers the campaign id, contract, chain, category, and SHA-256 hashes of the description and image, and it expires after 10 minutes.
- Uploads: PNG, JPEG or WebP only, checked by file signature (not just the declared type), 2 MB maximum.
- User text is inserted with text nodes (never `innerHTML`), so no XSS. A Content-Security-Policy, `nosniff` and frame protection are sent on every response.
- Simple per-IP rate limits on write endpoints. Secrets live in `.env` / Render environment variables, never in the repo.

## Getting started

Requirements: Node.js 22.9 or newer, MetaMask with some Sepolia ETH, and a MongoDB Atlas cluster.

```bash
npm install
cp .env.example .env        # then put your MongoDB connection string in .env
npm run compile             # compiles the contract and exports abi/Crowdfunding.json
npm test                    # 27 smart-contract tests
npm run test:server         # 13 backend tests (signatures and validation)
npm run dev                 # http://localhost:3000 (restarts on server changes)
```

First run only: open `http://localhost:3000/deploy.html`, deploy with MetaMask, and the address is saved to `deployments/sepolia.json` (commit this file). Each deployment gets its own MongoDB database named `crowdfunding_<first 8 hex digits of the address>`.

Gas usage report: `npx hardhat test --gas-stats`.

## Deploying to Render

Create a Render **Web Service** from this repository:

| Setting | Value |
|---|---|
| Build command | `npm install` |
| Start command | `npm start` |
| Environment variables | `NODE_ENV=production`, `MONGODB_URI`, `MONGODB_DB=crowdfunding` (optional: `SEPOLIA_RPC_URL`) |

In MongoDB Atlas, allow network access from `0.0.0.0/0`, because Render's free tier has no fixed IP address. The developer-only deploy routes are disabled when `NODE_ENV=production`.

## API

| Method and path | Purpose |
|---|---|
| `GET /api/config` | Contract address, ABI, chain info, limits |
| `GET /api/campaigns?q=&category=&status=&sort=` | List, search and sort campaigns |
| `GET /api/campaigns/:id` | Campaign, details, backers and event history |
| `POST /api/campaigns/:id/metadata` | Save description, category and cover image (creator signature required) |
| `GET /api/images/:id` | Cover image |
| `GET /api/users/:address` | A wallet's campaigns, contributions and pending actions |
| `GET /api/stats` | Platform totals |
| `POST /api/sync` | Index new contract events now (called after each transaction) |
| `GET /api/health` | Health check |

## Project structure

```
contracts/Crowdfunding.sol           smart contract
contracts/test/ReentrantBacker.sol   attacker contract, used only in tests
test/Crowdfunding.test.js            contract tests (Hardhat + Mocha)
abi/Crowdfunding.json                ABI used by the server and browser (npm run compile)
deployments/sepolia.json             deployed address and block (created by /deploy.html)
server/                              Express app, MongoDB access, event indexer, validation
server/test/                         backend tests (node:test)
public/                              pages, styles and browser JavaScript
public/js/shared/constants.js        rules shared by browser and server (limits, signed message)
scripts/export-abi.js                copies the ABI out of Hardhat's build output
```

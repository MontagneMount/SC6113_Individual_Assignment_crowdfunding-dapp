# CampusFund: Campus Crowdfunding DApp

An all-or-nothing crowdfunding DApp for campus projects (SC6113 individual assignment).
Creators raise Sepolia ETH before a deadline. If the goal is met, the creator withdraws the funds once; otherwise every backer reclaims their own contribution. Every rule about money is enforced by a Solidity smart contract.

## Live demo

- **Website:** https://sc6113-individual-assignment-0kth.onrender.com/
  (free Render instance: after 15 idle minutes the first visit can take about a minute to wake up)
- **Smart contract on Sepolia:** [`0xc898d65cbB8f51D4811acd5911685eBD9731C968`](https://sepolia.etherscan.io/address/0xc898d65cbB8f51D4811acd5911685eBD9731C968)
- **To try it:** install MetaMask, switch to the Sepolia test network and get free Sepolia ETH from a faucet. On a phone, open the site inside the MetaMask app.

## Submission files

| Item | Where |
|---|---|
| Smart contract (`.sol`) | [`contracts/Crowdfunding.sol`](contracts/Crowdfunding.sol) |
| ABI | [`abi/Crowdfunding.json`](abi/Crowdfunding.json) |
| Python Flask backend | [`app.py`](app.py) and [`backend/`](backend/) |
| HTML, CSS, JavaScript | [`public/`](public/) |
| Render link | https://sc6113-individual-assignment-0kth.onrender.com/ |
| Database | MongoDB Atlas, described in [`docs/DATABASE.md`](docs/DATABASE.md) |

## Features

| Page | What you can do |
|---|---|
| Explore (`/`) | Browse, search and filter campaigns; platform statistics |
| Campaign (`/campaign.html?id=…`) | Back a campaign, withdraw (creator) or claim a refund (backer); fund transparency panel, backers and on-chain activity with Etherscan links; raised/refunded totals and withdrawal status are compared with the cache for the "Verified on-chain" badge |
| Start a campaign (`/create.html`) | Create a campaign on-chain, then sign its description and cover image |
| My activity (`/me.html`) | Personal statistics, campaigns backed and created, refunds or withdrawals waiting for you |
| Visitor log (`/admin`, admin wallet only) | Every page visit with its time, page, connected wallet and browser; visit statistics; filter by page or wallet; delete one record, the filtered records or all of them |
| Deploy (`/deploy.html`, local only) | Deploy the contract to Sepolia with MetaMask |

Works on phones: the layout is mobile first, and phone browsers without MetaMask get an "Open in MetaMask app" link.

## Architecture

```
Browser (HTML/CSS/JS + ethers.js)
 |-- MetaMask signs transactions --> Crowdfunding contract (Sepolia)
 |                                            | events
 |                                            v
 `-- REST API (search, history,  --> Flask server --> MongoDB Atlas
     details, images)                 (indexer copies contract events)
```

- **The blockchain is the source of truth.** Balances, contributions and refund rights live only in the contract. MongoDB holds a rebuildable copy of the events (for fast search and history), off-chain details (descriptions, categories and cover images) and the visitor log.
- **Private keys never leave MetaMask.** The server never signs anything. Even the contract is deployed from MetaMask.

## Tech stack

| Layer | Technology |
|---|---|
| Smart contract | Solidity 0.8.28, OpenZeppelin Contracts 5 (`ReentrancyGuard`, `SafeCast`) |
| Contract tooling and tests | Hardhat 3 (Node.js), Mocha, Chai, ethers.js v6 |
| Frontend | HTML, CSS, JavaScript (ES modules), ethers.js v6, MetaMask |
| Backend | Python 3.12, Flask 3, web3.py (contract reads and signature checks), PyMongo, gunicorn |
| Backend tests | pytest |
| Database | MongoDB Atlas (free tier) |
| Network | Ethereum Sepolia testnet |
| Hosting | Render (web service) |

## Funding rules (enforced by the contract)

1. The goal and deadline are fixed when a campaign is created (deadline 1 minute to 90 days ahead).
2. Contributions are accepted only before the deadline, even after the goal is reached. The creator cannot withdraw early.
3. After the deadline, if the goal is met, only the creator can withdraw, and only once.
4. After the deadline, if the goal is missed, each backer refunds their own contribution.
5. Repeated contributions add up; a refund can be claimed only once.
6. The creator address cannot back its own campaign; another address owned by the same person is not blocked.

## Security highlights

- Contract: re-entrancy guard plus Checks-Effects-Interactions, pull-based refunds, custom errors, `SafeCast`, no `receive()` (plain ETH transfers are rejected).
- Campaign details can only be saved with a MetaMask signature from the on-chain creator. The signed message covers the campaign id, contract, chain, category, and SHA-256 hashes of the description and image, and it expires after 10 minutes. Each save must be newer than the stored version, and a compare-and-set update rejects stale or concurrent writes with HTTP 409.
- Uploads: PNG, JPEG or WebP only, checked by file signature (not just the declared type), 2 MB maximum.
- Visitor log: only the admin wallet (the contract deployer, or `ADMIN_ADDRESSES`) can read or delete it. The admin signs a sign-in message in MetaMask, and every request carries that signature, which expires after 10 minutes; there is no password or session cookie. No IP address is stored (a random id kept in the visitor's browser tells repeat visits apart), only a short browser label is kept instead of the full User-Agent, and a MongoDB TTL index deletes records after 30 days.
- User text is inserted with text nodes (never `innerHTML`), avoiding HTML interpretation of that text. A Content-Security-Policy, `nosniff` and frame protection are sent on every response.
- Simple per-IP rate limits on write endpoints. Secrets live in `.env` / Render environment variables, never in the repo.

## Getting started

Requirements: Python 3.12, Node.js 22.9 or newer (only for compiling and testing the contract), MetaMask with some Sepolia ETH, and a MongoDB Atlas cluster.

Web app (Flask). On macOS or Linux, activate the environment with `source .venv/bin/activate` instead:

```bash
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements-dev.txt
copy .env.example .env      # then put your MongoDB connection string in .env
python app.py               # http://localhost:3000
pytest                      # 58 backend tests
```

Smart contract (Hardhat):

```bash
npm install
npm run compile             # compiles the contract and exports abi/Crowdfunding.json
npm test                    # 27 smart-contract tests
```

For a new contract deployment only: open `http://localhost:3000/deploy.html`, deploy with MetaMask, and the address is saved to `deployments/sepolia.json` (commit this file). Each deployment gets its own MongoDB database named `crowdfunding_<first 8 hex digits of the address>`.

Gas usage report: `npx hardhat test --gas-stats`. After upgrading ethers, refresh the browser copy with `npm run vendor:ethers`.

## Deploying to Render

Create a Render **Web Service** (Python) from this repository:

| Setting | Value |
|---|---|
| Build command | `pip install -r requirements.txt` |
| Start command | `gunicorn app:app` (settings in `gunicorn.conf.py`) |
| Environment variables | `MONGODB_URI`, `MONGODB_DB=crowdfunding` (optional: `SEPOLIA_RPC_URL`, `SEPOLIA_HISTORY_RPC_URL`, `ADMIN_ADDRESSES`) |

`.python-version` selects Python 3.12. Render sets `RENDER=true`, which switches the app to production mode and turns off the developer-only deploy routes (`APP_ENV=production` does the same elsewhere). In MongoDB Atlas, allow network access from `0.0.0.0/0`, because Render's free tier has no fixed IP address.

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
| `POST /api/visits` | Record a page visit (sent by every page; rate limited) |
| `GET /api/admin/visits?page=&wallet=` | Visitor log and visit statistics (admin signature required) |
| `DELETE /api/admin/visits/:id` | Delete one visit record (admin) |
| `DELETE /api/admin/visits?page=&wallet=` | Delete the matching records, or all records without filters (admin) |
| `GET /api/health` | Health check |

## Project structure

```
contracts/Crowdfunding.sol           smart contract
contracts/test/ReentrantBacker.sol   attacker contract, used only in tests
test/Crowdfunding.test.js            contract tests (Hardhat + Mocha)
abi/Crowdfunding.json                ABI used by the server and browser (npm run compile)
deployments/sepolia.json             deployed address and block (created by /deploy.html)
app.py                               Flask entry point (python app.py, or gunicorn app:app)
backend/                             Flask API, MongoDB access, event indexer, validation, visitor log
tests/                               backend tests (pytest)
public/                              pages, styles and browser JavaScript
public/js/shared/constants.js        rules shared by browser and server (limits, signed message)
public/vendor/ethers/                ethers.js browser build (npm run vendor:ethers)
scripts/export-abi.js                copies the ABI out of Hardhat's build output
docs/DATABASE.md                     database collections, setup and recovery
```

## Database

[docs/DATABASE.md](docs/DATABASE.md) lists the collections and field types, explains how to rebuild the chain cache in a fresh database, and why descriptions and images need their own backup.

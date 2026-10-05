# Campus Crowdfunding DApp

An all-or-nothing crowdfunding DApp for campus projects (SC6113 individual assignment).
Creators raise Sepolia ETH before a deadline. If the goal is met, the creator withdraws the funds once; otherwise every backer reclaims their own contribution.

> **Status:** smart contract and automated tests are done (local chain). Frontend, backend and Sepolia deployment come next.

## Tech stack

| Layer | Technology |
|---|---|
| Smart contract | Solidity 0.8.28, OpenZeppelin Contracts 5 (`ReentrancyGuard`, `SafeCast`) |
| Development and tests | Hardhat 3, Mocha, Chai, ethers.js v6 |
| Frontend (planned) | HTML, CSS, JavaScript, ethers.js, MetaMask |
| Backend (planned) | Node.js, Express, SQLite |
| Network | Local Hardhat chain, then Ethereum Sepolia testnet |

## Funding rules

1. The goal and deadline are fixed when a campaign is created.
2. Contributions are accepted only before the deadline, even after the goal is reached. The creator cannot withdraw early.
3. After the deadline, if the goal is met, only the creator can withdraw, and only once.
4. After the deadline, if the goal is missed, each backer refunds their own contribution.
5. Repeated contributions add up; a refund can be claimed only once.
6. The creator cannot back their own campaign (prevents self-funding to fake success).

## Getting started

Requirements: Node.js 22 or newer (developed with Node 24).

```bash
npm install
npm run compile
npm test
```

Gas usage report:

```bash
npx hardhat test --gas-stats
```

## Project structure

```
contracts/Crowdfunding.sol           main contract
contracts/test/ReentrantBacker.sol   attacker contract, used only in tests
test/Crowdfunding.test.js            27 automated tests
hardhat.config.js                    Hardhat configuration
```

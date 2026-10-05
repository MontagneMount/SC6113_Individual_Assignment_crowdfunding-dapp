import { getContract } from "./chain.js";
import { ensureIndexes, isDbReady, useDeploymentDatabase } from "./db.js";
import { startIndexer, stopIndexer } from "./indexer.js";

/** The contract the server is currently working with (null until it is deployed). */
export const state = {
  deployment: null,
  contract: null,
};

export async function activateDeployment(deployment) {
  stopIndexer();
  state.deployment = deployment;
  state.contract = deployment ? getContract(deployment.address) : null;
  useDeploymentDatabase(deployment);

  if (!deployment) {
    console.log("No contract deployed yet: open /deploy.html locally to deploy it");
    return;
  }
  if (!isDbReady()) return;

  await ensureIndexes();
  await startIndexer(deployment, state.contract);
}

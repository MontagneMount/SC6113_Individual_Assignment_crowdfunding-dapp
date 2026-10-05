import { parseEther } from "/vendor/ethers/ethers.min.js";
import { getConfig } from "../api.js";
import { explainError, getWriteContract, runTransaction, saveCampaignDetails } from "../contract.js";
import { byteLength, checkImage, showError, wireImagePreview } from "../forms.js";
import { initLayout } from "../layout.js";
import { LIMITS, normalizeDescription } from "../shared/constants.js";
import { $, el, setBusy } from "../ui.js";

const form = $("#create-form");
const message = $("#form-message");
const submit = $("#submit");
const MIN_LEAD_SECONDS = 120; // a little more than the contract's 60s, to allow for confirmation time

async function main() {
  await initLayout("create");

  const config = await getConfig().catch(() => null);
  for (const category of config?.categories ?? []) form.elements.category.append(el("option", { value: category }, category));
  if (!config?.contractAddress) {
    $("#setup-notice").replaceChildren(
      el("div", { class: "callout callout-warning mb" }, el("p", {}, "The smart contract hasn't been deployed yet, so campaigns can't be created.")),
    );
    submit.disabled = true;
  }

  wireCounters();
  wireDeadlineShortcuts();
  wireImagePreview(form.elements.image, $("#image-preview"));
  form.addEventListener("submit", onSubmit);
}

function wireCounters() {
  const { title, description } = form.elements;
  const update = () => {
    $("#title-count").textContent = `${byteLength(title.value.trim())} / ${LIMITS.titleMaxBytes}`;
    $("#description-count").textContent = `${description.value.length} / ${LIMITS.descriptionMaxChars}`;
  };
  title.addEventListener("input", update);
  description.addEventListener("input", update);
  update();
}

function wireDeadlineShortcuts() {
  const input = form.elements.deadline;
  input.min = toLocalInputValue(new Date(Date.now() + MIN_LEAD_SECONDS * 1000));
  for (const chip of form.querySelectorAll("[data-minutes]")) {
    chip.addEventListener("click", () => {
      input.value = toLocalInputValue(new Date(Date.now() + Number(chip.dataset.minutes) * 60_000));
      showError($("#deadline-error"), null);
    });
  }
}

// <input type="datetime-local"> wants "YYYY-MM-DDTHH:MM" in local time.
function toLocalInputValue(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Checks every field, shows messages next to the invalid ones, returns the values or null. */
function readForm() {
  const { title, category, description, goal, deadline, image } = form.elements;
  const values = {
    title: title.value.trim(),
    category: category.value,
    description: normalizeDescription(description.value),
    file: image.files[0] ?? null,
  };
  const errors = {};

  const titleBytes = byteLength(values.title);
  if (titleBytes === 0) errors.title = "Please enter a title.";
  else if (titleBytes > LIMITS.titleMaxBytes) errors.title = `The title is too long (max ${LIMITS.titleMaxBytes} bytes).`;

  if (!values.category) errors.category = "Please choose a category.";
  if (!values.description) errors.description = "Please describe your campaign.";
  else if (values.description.length > LIMITS.descriptionMaxChars) errors.description = "The description is too long.";

  try {
    values.goalWei = parseEther(goal.value.trim());
    if (values.goalWei <= 0n) errors.goal = "The goal must be greater than 0.";
  } catch {
    errors.goal = "Enter a number of ETH, e.g. 0.05.";
  }

  const now = Math.floor(Date.now() / 1000);
  values.deadline = Math.floor(new Date(deadline.value).getTime() / 1000);
  if (!deadline.value || Number.isNaN(values.deadline)) errors.deadline = "Please pick a deadline.";
  else if (values.deadline < now + MIN_LEAD_SECONDS) errors.deadline = "The deadline must be at least 2 minutes from now.";
  else if (values.deadline > now + LIMITS.maxDurationSeconds - 60) errors.deadline = "The deadline must be within 90 days.";

  const imageProblem = checkImage(values.file);
  if (imageProblem) errors.image = imageProblem;

  for (const name of ["title", "category", "description", "goal", "deadline", "image"]) {
    showError($(`#${name}-error`), errors[name]);
    form.elements[name].classList.toggle("invalid", Boolean(errors[name]));
  }
  const firstInvalid = Object.keys(errors)[0];
  if (firstInvalid) {
    form.elements[firstInvalid].focus();
    return null;
  }
  return values;
}

function setStep(step) {
  $("#step-1").className = step === 1 ? "step current" : "step done";
  $("#step-2").className = step === 2 ? "step current" : "step";
}

function setFormLocked(locked) {
  for (const element of form.elements) element.disabled = locked;
}

async function onSubmit(event) {
  event.preventDefault();
  message.replaceChildren();
  const values = readForm();
  if (!values) return;

  setFormLocked(true);
  setBusy(submit, true, "Step 1 of 2: confirm in MetaMask…");

  // Step 1: create the campaign on the blockchain.
  let campaignId;
  try {
    const contract = await getWriteContract();
    const receipt = await runTransaction("Create campaign", () =>
      contract.createCampaign(values.title, values.goalWei, values.deadline),
    );
    campaignId = findCampaignId(contract, receipt);
  } catch (err) {
    message.replaceChildren(el("div", { class: "callout callout-danger mb" }, el("p", {}, await explainError(err))));
    setFormLocked(false);
    setBusy(submit, false);
    return;
  }

  // Step 2: sign and save the description and cover image (free, no gas).
  setStep(2);
  setBusy(submit, true, "Step 2 of 2: sign the message in MetaMask…");
  await saveDetails(campaignId, values);
}

async function saveDetails(campaignId, values) {
  try {
    await saveCampaignDetails({ campaignId, ...values });
    location.href = `/campaign.html?id=${campaignId}&created=1`;
  } catch (err) {
    const retry = el("button", { class: "btn btn-primary", type: "button" }, "Try signing again");
    retry.addEventListener("click", () => {
      retry.disabled = true;
      saveDetails(campaignId, values);
    });
    message.replaceChildren(
      el(
        "div",
        { class: "callout callout-warning mb stack" },
        el("p", {}, `Your campaign #${campaignId} is live on the blockchain, but its description wasn't saved: ${await explainError(err)}`),
        el("div", { class: "row" }, retry, el("a", { class: "btn btn-secondary", href: `/campaign.html?id=${campaignId}` }, "Go to the campaign")),
      ),
    );
    setBusy(submit, true, "Campaign created");
  }
}

function findCampaignId(contract, receipt) {
  for (const log of receipt.logs) {
    try {
      const parsed = contract.interface.parseLog(log);
      if (parsed?.name === "CampaignCreated") return parsed.args.campaignId.toString();
    } catch {
      // a log from another contract
    }
  }
  throw new Error("The campaign was created, but its id could not be read from the transaction.");
}

main();

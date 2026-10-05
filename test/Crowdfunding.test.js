import { expect } from "chai";
import { network } from "hardhat";

const { ethers, networkHelpers } = await network.create();
const { time, loadFixture } = networkHelpers;

const Status = { Active: 0, Successful: 1, Failed: 2, Withdrawn: 3 };
const ONE_HOUR = 60 * 60;
const ONE_DAY = 24 * ONE_HOUR;
const TITLE = "Campus Board Game Design";
const GOAL = ethers.parseEther("1");
const eth = (value) => ethers.parseEther(value);

// ---------- Fixtures: each one builds on the previous state ----------

async function deployFixture() {
  const [creator, backerA, backerB, stranger] = await ethers.getSigners();
  const crowdfunding = await ethers.deployContract("Crowdfunding");
  return { crowdfunding, creator, backerA, backerB, stranger };
}

async function activeCampaignFixture() {
  const fixture = await deployFixture();
  const deadline = (await time.latest()) + ONE_HOUR;
  await fixture.crowdfunding.connect(fixture.creator).createCampaign(TITLE, GOAL, deadline);
  return { ...fixture, campaignId: 1n, deadline };
}

// Goal reached (0.6 + 0.5 = 1.1 ETH) but the deadline has not passed yet.
async function fundedCampaignFixture() {
  const fixture = await activeCampaignFixture();
  const { crowdfunding, backerA, backerB, campaignId } = fixture;
  await crowdfunding.connect(backerA).contribute(campaignId, { value: eth("0.6") });
  await crowdfunding.connect(backerB).contribute(campaignId, { value: eth("0.5") });
  return fixture;
}

async function successfulCampaignFixture() {
  const fixture = await fundedCampaignFixture();
  await time.increaseTo(fixture.deadline);
  return fixture;
}

// Goal missed: A gives 0.2 twice, B gives 0.3, total 0.7 ETH < 1 ETH.
async function underfundedCampaignFixture() {
  const fixture = await activeCampaignFixture();
  const { crowdfunding, backerA, backerB, campaignId } = fixture;
  await crowdfunding.connect(backerA).contribute(campaignId, { value: eth("0.2") });
  await crowdfunding.connect(backerA).contribute(campaignId, { value: eth("0.2") });
  await crowdfunding.connect(backerB).contribute(campaignId, { value: eth("0.3") });
  return fixture;
}

async function failedCampaignFixture() {
  const fixture = await underfundedCampaignFixture();
  await time.increaseTo(fixture.deadline);
  return fixture;
}

// ---------- Tests ----------

describe("Crowdfunding", function () {
  describe("createCampaign", function () {
    it("stores the campaign and emits CampaignCreated", async function () {
      const { crowdfunding, creator } = await loadFixture(deployFixture);
      const deadline = (await time.latest()) + ONE_HOUR;

      await expect(crowdfunding.connect(creator).createCampaign(TITLE, GOAL, deadline))
        .to.emit(crowdfunding, "CampaignCreated")
        .withArgs(1n, creator.address, TITLE, GOAL, deadline);

      const [campaign, status] = await crowdfunding.getCampaign(1n);
      expect(campaign.creator).to.equal(creator.address);
      expect(campaign.title).to.equal(TITLE);
      expect(campaign.goal).to.equal(GOAL);
      expect(campaign.deadline).to.equal(deadline);
      expect(campaign.totalRaised).to.equal(0n);
      expect(campaign.withdrawn).to.equal(false);
      expect(status).to.equal(Status.Active);
      expect(await crowdfunding.campaignCount()).to.equal(1n);
    });

    it("gives every campaign its own increasing id", async function () {
      const { crowdfunding, creator, stranger } = await loadFixture(deployFixture);
      const deadline = (await time.latest()) + ONE_HOUR;

      await crowdfunding.connect(creator).createCampaign("First", GOAL, deadline);
      await expect(crowdfunding.connect(stranger).createCampaign("Second", GOAL, deadline))
        .to.emit(crowdfunding, "CampaignCreated")
        .withArgs(2n, stranger.address, "Second", GOAL, deadline);
      expect(await crowdfunding.campaignCount()).to.equal(2n);
    });

    it("rejects an empty or too long title", async function () {
      const { crowdfunding } = await loadFixture(deployFixture);
      const deadline = (await time.latest()) + ONE_HOUR;

      await expect(crowdfunding.createCampaign("", GOAL, deadline)).to.be.revertedWithCustomError(
        crowdfunding,
        "InvalidTitle",
      );
      await expect(crowdfunding.createCampaign("x".repeat(81), GOAL, deadline)).to.be.revertedWithCustomError(
        crowdfunding,
        "InvalidTitle",
      );
    });

    it("rejects a zero goal", async function () {
      const { crowdfunding } = await loadFixture(deployFixture);
      const deadline = (await time.latest()) + ONE_HOUR;

      await expect(crowdfunding.createCampaign(TITLE, 0, deadline)).to.be.revertedWithCustomError(
        crowdfunding,
        "InvalidGoal",
      );
    });

    it("rejects a deadline that is too soon or too far away", async function () {
      const { crowdfunding } = await loadFixture(deployFixture);
      const now = (await time.latest()) + 10;

      await time.setNextBlockTimestamp(now);
      await expect(crowdfunding.createCampaign(TITLE, GOAL, now + 59))
        .to.be.revertedWithCustomError(crowdfunding, "InvalidDeadline")
        .withArgs(now + 59, now + 60, now + 90 * ONE_DAY);

      await expect(crowdfunding.createCampaign(TITLE, GOAL, now + 91 * ONE_DAY)).to.be.revertedWithCustomError(
        crowdfunding,
        "InvalidDeadline",
      );
    });

    it("accepts the shortest allowed duration (1 minute)", async function () {
      const { crowdfunding } = await loadFixture(deployFixture);
      const now = (await time.latest()) + 10;

      await time.setNextBlockTimestamp(now);
      await expect(crowdfunding.createCampaign(TITLE, GOAL, now + 60)).to.emit(crowdfunding, "CampaignCreated");
    });
  });

  describe("contribute", function () {
    it("adds up repeated contributions per backer and in total", async function () {
      const { crowdfunding, backerA, backerB, campaignId } = await loadFixture(activeCampaignFixture);

      await expect(crowdfunding.connect(backerA).contribute(campaignId, { value: eth("0.3") }))
        .to.emit(crowdfunding, "Contributed")
        .withArgs(campaignId, backerA.address, eth("0.3"), eth("0.3"));
      await crowdfunding.connect(backerA).contribute(campaignId, { value: eth("0.2") });
      await crowdfunding.connect(backerB).contribute(campaignId, { value: eth("0.1") });

      expect(await crowdfunding.contributions(campaignId, backerA.address)).to.equal(eth("0.5"));
      expect(await crowdfunding.contributions(campaignId, backerB.address)).to.equal(eth("0.1"));

      const [campaign] = await crowdfunding.getCampaign(campaignId);
      expect(campaign.totalRaised).to.equal(eth("0.6"));
      expect(campaign.backerCount).to.equal(2);
    });

    it("moves the ETH from the backer into the contract", async function () {
      const { crowdfunding, backerA, campaignId } = await loadFixture(activeCampaignFixture);

      await expect(crowdfunding.connect(backerA).contribute(campaignId, { value: eth("0.4") })).to.changeEtherBalances(
        ethers,
        [backerA, crowdfunding],
        [-eth("0.4"), eth("0.4")],
      );
    });

    it("keeps accepting contributions after the goal is reached, until the deadline", async function () {
      const { crowdfunding, stranger, campaignId } = await loadFixture(fundedCampaignFixture);

      await crowdfunding.connect(stranger).contribute(campaignId, { value: eth("0.1") });
      const [campaign, status] = await crowdfunding.getCampaign(campaignId);
      expect(campaign.totalRaised).to.equal(eth("1.2"));
      expect(status).to.equal(Status.Active);
    });

    it("rejects a zero-value contribution", async function () {
      const { crowdfunding, backerA, campaignId } = await loadFixture(activeCampaignFixture);

      await expect(crowdfunding.connect(backerA).contribute(campaignId, { value: 0 })).to.be.revertedWithCustomError(
        crowdfunding,
        "ZeroContribution",
      );
    });

    it("rejects the creator funding their own campaign", async function () {
      const { crowdfunding, creator, campaignId } = await loadFixture(activeCampaignFixture);

      await expect(
        crowdfunding.connect(creator).contribute(campaignId, { value: eth("1") }),
      ).to.be.revertedWithCustomError(crowdfunding, "CreatorCannotContribute");
    });

    it("rejects a campaign id that does not exist", async function () {
      const { crowdfunding, backerA } = await loadFixture(activeCampaignFixture);

      await expect(crowdfunding.connect(backerA).contribute(99, { value: eth("0.1") }))
        .to.be.revertedWithCustomError(crowdfunding, "CampaignNotFound")
        .withArgs(99);
      await expect(crowdfunding.connect(backerA).contribute(0, { value: eth("0.1") }))
        .to.be.revertedWithCustomError(crowdfunding, "CampaignNotFound")
        .withArgs(0);
    });

    it("accepts a contribution 1 second before the deadline but not at the deadline", async function () {
      const { crowdfunding, backerA, campaignId, deadline } = await loadFixture(activeCampaignFixture);

      await time.setNextBlockTimestamp(deadline - 1);
      await crowdfunding.connect(backerA).contribute(campaignId, { value: eth("0.1") });

      await time.setNextBlockTimestamp(deadline);
      await expect(crowdfunding.connect(backerA).contribute(campaignId, { value: eth("0.1") }))
        .to.be.revertedWithCustomError(crowdfunding, "CampaignEnded")
        .withArgs(deadline);
    });
  });

  describe("withdraw (successful campaign)", function () {
    it("pays the full amount to the creator after the deadline", async function () {
      const { crowdfunding, creator, campaignId } = await loadFixture(successfulCampaignFixture);

      await expect(crowdfunding.connect(creator).withdraw(campaignId)).to.changeEtherBalances(
        ethers,
        [creator, crowdfunding],
        [eth("1.1"), -eth("1.1")],
      );
      expect(await crowdfunding.getStatus(campaignId)).to.equal(Status.Withdrawn);
    });

    it("emits FundsWithdrawn", async function () {
      const { crowdfunding, creator, campaignId } = await loadFixture(successfulCampaignFixture);

      await expect(crowdfunding.connect(creator).withdraw(campaignId))
        .to.emit(crowdfunding, "FundsWithdrawn")
        .withArgs(campaignId, creator.address, eth("1.1"));
    });

    it("is allowed exactly at the deadline", async function () {
      const { crowdfunding, creator, campaignId, deadline } = await loadFixture(fundedCampaignFixture);

      await time.setNextBlockTimestamp(deadline);
      await expect(crowdfunding.connect(creator).withdraw(campaignId)).to.emit(crowdfunding, "FundsWithdrawn");
    });

    it("rejects withdrawal before the deadline even when the goal is reached", async function () {
      const { crowdfunding, creator, campaignId, deadline } = await loadFixture(fundedCampaignFixture);

      await expect(crowdfunding.connect(creator).withdraw(campaignId))
        .to.be.revertedWithCustomError(crowdfunding, "CampaignStillActive")
        .withArgs(deadline);
    });

    it("rejects withdrawal by anyone except the creator", async function () {
      const { crowdfunding, backerA, stranger, campaignId } = await loadFixture(successfulCampaignFixture);

      await expect(crowdfunding.connect(backerA).withdraw(campaignId)).to.be.revertedWithCustomError(
        crowdfunding,
        "NotCreator",
      );
      await expect(crowdfunding.connect(stranger).withdraw(campaignId)).to.be.revertedWithCustomError(
        crowdfunding,
        "NotCreator",
      );
    });

    it("rejects withdrawal when the goal was missed", async function () {
      const { crowdfunding, creator, campaignId } = await loadFixture(failedCampaignFixture);

      await expect(crowdfunding.connect(creator).withdraw(campaignId))
        .to.be.revertedWithCustomError(crowdfunding, "GoalNotReached")
        .withArgs(eth("0.7"), GOAL);
    });

    it("rejects a second withdrawal", async function () {
      const { crowdfunding, creator, campaignId } = await loadFixture(successfulCampaignFixture);

      await crowdfunding.connect(creator).withdraw(campaignId);
      await expect(crowdfunding.connect(creator).withdraw(campaignId)).to.be.revertedWithCustomError(
        crowdfunding,
        "AlreadyWithdrawn",
      );
    });

    it("rejects refunds on a successful campaign", async function () {
      const { crowdfunding, backerA, campaignId } = await loadFixture(successfulCampaignFixture);

      await expect(crowdfunding.connect(backerA).refund(campaignId))
        .to.be.revertedWithCustomError(crowdfunding, "GoalReached")
        .withArgs(eth("1.1"), GOAL);
    });
  });

  describe("refund (failed campaign)", function () {
    it("returns each backer's full contribution after the deadline", async function () {
      const { crowdfunding, backerA, backerB, campaignId } = await loadFixture(failedCampaignFixture);
      expect(await crowdfunding.getStatus(campaignId)).to.equal(Status.Failed);

      await expect(crowdfunding.connect(backerA).refund(campaignId)).to.changeEtherBalances(
        ethers,
        [backerA, crowdfunding],
        [eth("0.4"), -eth("0.4")],
      );
      await expect(crowdfunding.connect(backerB).refund(campaignId))
        .to.emit(crowdfunding, "Refunded")
        .withArgs(campaignId, backerB.address, eth("0.3"));

      const [campaign] = await crowdfunding.getCampaign(campaignId);
      expect(campaign.totalRefunded).to.equal(eth("0.7"));
      expect(await ethers.provider.getBalance(crowdfunding)).to.equal(0n);
    });

    it("rejects refunds before the deadline", async function () {
      const { crowdfunding, backerA, campaignId, deadline } = await loadFixture(underfundedCampaignFixture);

      await expect(crowdfunding.connect(backerA).refund(campaignId))
        .to.be.revertedWithCustomError(crowdfunding, "CampaignStillActive")
        .withArgs(deadline);
    });

    it("rejects a second refund", async function () {
      const { crowdfunding, backerA, campaignId } = await loadFixture(failedCampaignFixture);

      await crowdfunding.connect(backerA).refund(campaignId);
      await expect(crowdfunding.connect(backerA).refund(campaignId)).to.be.revertedWithCustomError(
        crowdfunding,
        "NothingToRefund",
      );
    });

    it("rejects refunds from an address that never contributed", async function () {
      const { crowdfunding, stranger, campaignId } = await loadFixture(failedCampaignFixture);

      await expect(crowdfunding.connect(stranger).refund(campaignId)).to.be.revertedWithCustomError(
        crowdfunding,
        "NothingToRefund",
      );
    });
  });

  describe("security", function () {
    it("blocks a re-entrancy attack during refund and keeps other backers' money safe", async function () {
      const { crowdfunding, backerA, campaignId, deadline } = await loadFixture(activeCampaignFixture);
      const attacker = await ethers.deployContract("ReentrantBacker", [await crowdfunding.getAddress()]);

      await attacker.contribute(campaignId, { value: eth("0.2") });
      await crowdfunding.connect(backerA).contribute(campaignId, { value: eth("0.3") });
      await time.increaseTo(deadline);

      // The attacker re-enters refund() from its receive(); the guard makes the whole call fail.
      await expect(attacker.attackRefund(campaignId)).to.be.revertedWithCustomError(crowdfunding, "TransferFailed");
      expect(await ethers.provider.getBalance(crowdfunding)).to.equal(eth("0.5"));

      // An honest backer is unaffected.
      await expect(crowdfunding.connect(backerA).refund(campaignId)).to.changeEtherBalances(
        ethers,
        [backerA],
        [eth("0.3")],
      );
    });

    it("rejects plain ETH sent directly to the contract", async function () {
      const { crowdfunding, backerA } = await loadFixture(deployFixture);

      await expect(backerA.sendTransaction({ to: await crowdfunding.getAddress(), value: eth("0.1") })).to.revert(
        ethers,
      );
    });
  });
});

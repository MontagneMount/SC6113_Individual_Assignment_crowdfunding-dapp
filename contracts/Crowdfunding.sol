// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/// @title Campus Crowdfunding (all-or-nothing)
/// @notice Creators raise ETH for campus projects. If the goal is reached by the
///         deadline, the creator withdraws everything once; otherwise every backer
///         reclaims their own contribution. This contract is the single source of
///         truth for all money: balances, contributions and refund eligibility.
contract Crowdfunding is ReentrancyGuard {
    using SafeCast for uint256;

    enum Status {
        Active, // before the deadline: accepting contributions
        Successful, // deadline passed and goal reached: creator may withdraw
        Failed, // deadline passed and goal missed: backers may refund
        Withdrawn // successful campaign whose funds were withdrawn
    }

    /// @dev Field order keeps the fixed-size fields in 3 storage slots.
    struct Campaign {
        address creator;
        uint64 deadline;
        bool withdrawn;
        uint128 goal;
        uint128 totalRaised;
        uint128 totalRefunded;
        uint32 backerCount;
        string title;
    }

    uint256 public constant MIN_DURATION = 1 minutes;
    uint256 public constant MAX_DURATION = 90 days;
    uint256 public constant MAX_TITLE_LENGTH = 80; // in bytes (UTF-8)

    /// @notice Number of campaigns created; ids run from 1 to campaignCount.
    uint256 public campaignCount;

    mapping(uint256 campaignId => Campaign) private _campaigns;
    mapping(uint256 campaignId => mapping(address backer => uint256 amount)) public contributions;

    event CampaignCreated(
        uint256 indexed campaignId,
        address indexed creator,
        string title,
        uint256 goal,
        uint256 deadline
    );
    event Contributed(uint256 indexed campaignId, address indexed backer, uint256 amount, uint256 totalRaised);
    event FundsWithdrawn(uint256 indexed campaignId, address indexed creator, uint256 amount);
    event Refunded(uint256 indexed campaignId, address indexed backer, uint256 amount);

    error CampaignNotFound(uint256 campaignId);
    error InvalidTitle();
    error InvalidGoal();
    error InvalidDeadline(uint256 deadline, uint256 earliest, uint256 latest);
    error ZeroContribution();
    error CreatorCannotContribute();
    error CampaignEnded(uint256 deadline);
    error CampaignStillActive(uint256 deadline);
    error NotCreator();
    error GoalNotReached(uint256 raised, uint256 goal);
    error GoalReached(uint256 raised, uint256 goal);
    error AlreadyWithdrawn();
    error NothingToRefund();
    error TransferFailed();

    /// @notice Start a campaign. Goal and deadline are fixed once created.
    /// @param deadline Unix timestamp (seconds) after which no contributions are accepted.
    function createCampaign(string calldata title, uint256 goal, uint256 deadline)
        external
        returns (uint256 campaignId)
    {
        uint256 titleLength = bytes(title).length;
        if (titleLength == 0 || titleLength > MAX_TITLE_LENGTH) revert InvalidTitle();
        if (goal == 0) revert InvalidGoal();

        uint256 earliest = block.timestamp + MIN_DURATION;
        uint256 latest = block.timestamp + MAX_DURATION;
        if (deadline < earliest || deadline > latest) revert InvalidDeadline(deadline, earliest, latest);

        campaignId = ++campaignCount;
        Campaign storage campaign = _campaigns[campaignId];
        campaign.creator = msg.sender;
        campaign.deadline = deadline.toUint64();
        campaign.goal = goal.toUint128();
        campaign.title = title;

        emit CampaignCreated(campaignId, msg.sender, title, goal, deadline);
    }

    /// @notice Back a campaign before its deadline. Repeated contributions add up.
    function contribute(uint256 campaignId) external payable {
        Campaign storage campaign = _getCampaign(campaignId);
        if (msg.value == 0) revert ZeroContribution();
        if (msg.sender == campaign.creator) revert CreatorCannotContribute();
        if (block.timestamp >= campaign.deadline) revert CampaignEnded(campaign.deadline);

        uint256 previous = contributions[campaignId][msg.sender];
        if (previous == 0) campaign.backerCount += 1;
        contributions[campaignId][msg.sender] = previous + msg.value;

        uint128 newTotal = campaign.totalRaised + msg.value.toUint128();
        campaign.totalRaised = newTotal;

        emit Contributed(campaignId, msg.sender, msg.value, newTotal);
    }

    /// @notice Creator collects all funds once the deadline has passed and the goal is met.
    function withdraw(uint256 campaignId) external nonReentrant {
        Campaign storage campaign = _getCampaign(campaignId);
        if (msg.sender != campaign.creator) revert NotCreator();
        if (block.timestamp < campaign.deadline) revert CampaignStillActive(campaign.deadline);
        if (campaign.totalRaised < campaign.goal) revert GoalNotReached(campaign.totalRaised, campaign.goal);
        if (campaign.withdrawn) revert AlreadyWithdrawn();

        // Checks-Effects-Interactions: update state before sending ETH.
        campaign.withdrawn = true;
        uint256 amount = campaign.totalRaised;
        emit FundsWithdrawn(campaignId, msg.sender, amount);

        _sendValue(msg.sender, amount);
    }

    /// @notice Backer reclaims their own contribution after a failed campaign.
    function refund(uint256 campaignId) external nonReentrant {
        Campaign storage campaign = _getCampaign(campaignId);
        if (block.timestamp < campaign.deadline) revert CampaignStillActive(campaign.deadline);
        if (campaign.totalRaised >= campaign.goal) revert GoalReached(campaign.totalRaised, campaign.goal);

        uint256 amount = contributions[campaignId][msg.sender];
        if (amount == 0) revert NothingToRefund();

        // Checks-Effects-Interactions: clear the balance before sending ETH.
        contributions[campaignId][msg.sender] = 0;
        campaign.totalRefunded += amount.toUint128();
        emit Refunded(campaignId, msg.sender, amount);

        _sendValue(msg.sender, amount);
    }

    function getCampaign(uint256 campaignId) external view returns (Campaign memory campaign, Status status) {
        Campaign storage stored = _getCampaign(campaignId);
        return (stored, _statusOf(stored));
    }

    function getStatus(uint256 campaignId) external view returns (Status) {
        return _statusOf(_getCampaign(campaignId));
    }

    function _getCampaign(uint256 campaignId) private view returns (Campaign storage) {
        if (campaignId == 0 || campaignId > campaignCount) revert CampaignNotFound(campaignId);
        return _campaigns[campaignId];
    }

    function _statusOf(Campaign storage campaign) private view returns (Status) {
        if (block.timestamp < campaign.deadline) return Status.Active;
        if (campaign.totalRaised < campaign.goal) return Status.Failed;
        return campaign.withdrawn ? Status.Withdrawn : Status.Successful;
    }

    function _sendValue(address to, uint256 amount) private {
        (bool success,) = payable(to).call{value: amount}("");
        if (!success) revert TransferFailed();
    }
}

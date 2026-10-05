// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface ICrowdfunding {
    function contribute(uint256 campaignId) external payable;
    function refund(uint256 campaignId) external;
}

/// @notice Test-only attacker. When it receives a refund, it immediately calls
///         refund() again to try to drain the campaign (a re-entrancy attack).
contract ReentrantBacker {
    ICrowdfunding public immutable target;
    uint256 private _campaignId;

    constructor(ICrowdfunding target_) {
        target = target_;
    }

    function contribute(uint256 campaignId) external payable {
        target.contribute{value: msg.value}(campaignId);
    }

    function attackRefund(uint256 campaignId) external {
        _campaignId = campaignId;
        target.refund(campaignId);
    }

    receive() external payable {
        target.refund(_campaignId);
    }
}

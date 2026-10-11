"""The browser (public/js/shared/constants.js) and this backend must validate input and build
the signed message in exactly the same way, or creators' signatures would fail to verify.
These tests run the browser's JavaScript with Node.js and compare the results."""
import json
import shutil
import subprocess

import pytest

from backend import config
from backend.constants import CATEGORIES, LIMITS, SEPOLIA, build_details_message, normalize_description

NODE = shutil.which("node")
pytestmark = pytest.mark.skipif(NODE is None, reason="Node.js is not installed")
SHARED_MODULE = (config.PUBLIC_DIR / "js" / "shared" / "constants.js").as_uri()


def run_browser_code(body, data=None):
    """Runs `body` with Node.js (it can use `shared` and `input`) and returns its JSON result."""
    script = (
        f'import * as shared from "{SHARED_MODULE}";\n'
        'process.stdin.setEncoding("utf8");\n'
        'let text = "";\n'
        "for await (const chunk of process.stdin) text += chunk;\n"
        "const input = JSON.parse(text);\n"
        f"const result = (() => {{ {body} }})();\n"
        "process.stdout.write(JSON.stringify(result));\n"
    )
    done = subprocess.run(
        [NODE, "--input-type=module", "-e", script],
        input=json.dumps(data),
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=True,
    )
    return json.loads(done.stdout)


def test_chain_categories_and_limits_match_the_browser():
    browser = run_browser_code("return { SEPOLIA: shared.SEPOLIA, CATEGORIES: shared.CATEGORIES, LIMITS: shared.LIMITS };")
    assert browser == {"SEPOLIA": SEPOLIA, "CATEGORIES": CATEGORIES, "LIMITS": LIMITS}


def test_descriptions_are_normalised_like_the_browser():
    texts = [
        "  Plain text  ",
        "Line one\r\nLine two\rLine three",
        " ﻿ padded  　",
        "\x1c kept by JavaScript \x1c",
        "Board game 🎲 桌游\n",
    ]
    assert run_browser_code("return input.map((text) => shared.normalizeDescription(text));", texts) == [
        normalize_description(text) for text in texts
    ]


def test_signed_message_matches_the_browser():
    fields = {
        "campaignId": 7,
        "contractAddress": "0xc898d65cbB8f51D4811acd5911685eBD9731C968",
        "chainId": 11155111,
        "category": "Arts & Design",
        "descriptionSha256": "ab" * 32,
        "imageSha256": None,
        "issuedAt": "2026-10-11T08:00:00.000Z",
    }
    browser = run_browser_code(
        "return [shared.buildDetailsMessage(input), shared.buildDetailsMessage({ ...input, imageSha256: 'cd'.repeat(32) })];",
        fields,
    )
    python_args = dict(
        campaign_id=7,
        contract_address=fields["contractAddress"],
        chain_id=11155111,
        category="Arts & Design",
        description_sha256="ab" * 32,
        issued_at=fields["issuedAt"],
    )
    assert browser == [
        build_details_message(**python_args, image_sha256=None),
        build_details_message(**python_args, image_sha256="cd" * 32),
    ]

# Sentinel Ultra Submitter Form Answers

Task bf7f52... (avaiga/taipy #2733), base ab2c94e5. Implementation feature, Python with a TypeScript front end.

---

## Section 2 · Task Analysis

**Verdict (both instances, must match): Fixable**

### 1. Where the task had issues

- [x] Instructions  [x] Tests  [x] Oracle Solution  [x] Environment / Dockerfile

### 2. What issues did you find

- [x] Requirements not properly tested
- [x] Test requirements not specified in instructions
- [x] Instructions appear LLM generated
- [x] Oracle does not implement the solution per instructions
- [ ] Overly prescriptive · [ ] Leaks solution · [ ] Fewer than 10 f2p (shipped 19)

### 3. Describe each issue in detail

**1) [Tests / Instructions]** The tests needed a class called ChartAnimation with specific fields, defaults and to_json keys, but the instruction never named any of it, and it could not be worked out from the repo because the module does not exist at the base commit. Anyone following the instruction still failed three tests. It is fixable, and I wrote the whole contract into the instruction.

**2) [Tests / Instructions]** The abstract base class JsonProperty had the same trouble: the tests imported it by name, the instruction never gave one. Fixable. I named it and said both classes should import straight from taipy.gui.

**3) [Instructions]** The negative key offset was ambiguous. The instruction called it a distance from the front, but the tests need minus one to mean the first position, and that reading is not the only one. Fixable. I now say the position counts from the front starting at zero for a key of minus one.

**4) [Tests]** A key landing at or past the end has to grow the list, but the instruction only promised that for one sign of key. Fixable. I added it as one rule covering either sign.

**5) [Oracle Solution]** The golden patch broke something it is meant to keep. Inside the branch for a key within the list it tested for a dict and then, in a second separate if, for a list. Since a dict is not a list, a dict change was merged and then overwritten by the raw dict, so any key it did not mention was lost. I confirmed this in the built image. Fixable. I changed the second if to an elif and added a test that checks the untouched key survives.

**6) [Tests]** The paragraph about keeping old behaviour had almost nothing enforcing it. Only two pass to pass tests were listed, and the eight tests already in the file were left out, so an agent could break all of them and still pass. Fixable. I listed all eight and added guards, taking pass to pass from two to fourteen.

**7) [Tests]** The base class test checked that JsonProperty subclasses abc.ABC, which is both too strict and too loose. Fixable. I rewrote it to check behaviour: instantiating the base or an unfinished subclass raises, a finished one works.

**8) [Tests / Oracle]** The rule that to_json must run with no arguments was unenforced, and the oracle got it wrong. It used ismethod, so a to_json written as a staticmethod or assigned to the instance was refused even though it takes no arguments, and an empty collection came back as None. Fixable. I made it accept any callable that needs no arguments while still refusing one that needs an argument, added a staticmethod test, and narrowed the instruction to a list or tuple that holds only such objects and has at least one.

**9) [Instructions]** The writing read as generated, with bold run in headings and a line announcing there were two new behaviours. Fixable. I rewrote it as plain prose with no headings, emphasis or backticks.

**10) [Tests / Oracle / Environment]** The front end file the PR changes, patch.ts, was never graded. Reverting it to base still passed everything, and that gap hid a bug: the front end removal deleted entries as it walked them, so taking positions 0 and minus 2 out of a three item list returned the wrong element. Fixable. I fixed the removal to resolve every key against the original list and delete from the back, added Node and esbuild to the image so the verifier can transpile and run the real patch.ts through a small subprocess, and added front end tests. Reverting the front end now scores zero.

**11) [Environment]** frozen-requirements.txt carried a line, `-e git+https://github.com/avaiga/taipy.git@5bcb...`, that pulls taipy from GitHub at a different commit than the base. The repo is already installed locally, so the line only forced a needless network clone of the wrong version. Fixable. I removed it. The build still reaches the network for apt and pip, the same as every task of this shape and matching the task's original public build setting; the agent and verifier both run offline.

**12) [Environment]** A leftover authoring reflog was present, a single checkout back and forth at the base commit with a clean tree. Fixable under the benign reflog rule. I deleted .git/logs and a stray ORIG_HEAD my own tooling left behind, touching no tracked file or commit.

**13) [Metadata]** task.toml still had network_mode in all three sections and an allowed_hosts list, was missing os, had no difficulty_explanation, and its model_difficulty said medium while difficulty said hard. Fixable. I removed the network fields, added os and an explanation, and set model_difficulty to hard.

### 4. Reupload

One zip that unpacks straight to instruction.md, task.toml, environment/, solution/ and tests/. No runs/, no wrapping folder. The sweeps come back clean.

### 5. Files Changed

I rewrote instruction.md as prose so it now states the offset rule, the grow at the end rule for either sign, removal by position, the matching client and server behaviour, the JsonProperty and ChartAnimation contract, the import from taipy.gui, and the serialisation rule. This covers issues 1 to 4 and 8 to 10.

I copied that same text back into environment/problem_statement.md so the two match.

In solution/golden.patch the second if became an elif, removal by negative key was added on the Python side, the front end removal was rewritten to resolve against the original list and delete from the back with a single value splice, and the serialisation holder now takes any zero argument callable and handles a collection. This is issues 5, 8 and 10.

I dropped the git+https taipy line from environment/frozen-requirements.txt for issue 11, and added nodejs, npm and a pinned esbuild to environment/Dockerfile so the front end can run at grade time for issue 10.

tests/tests.patch only adds new functions, so the file stays identical to base. It brings the insert, grow and remove tests, the sibling check, the staticmethod and collection tests, the warning assertions, and the front end tests, covering issues 5 to 8 and 10.

tests/config.json now lists 17 fail to pass and 14 pass to pass with allow_extra_failures off, for issues 6 and 10.

task.toml lost the network fields and gained os and difficulty_explanation, with model_difficulty set to hard, for issue 13. I also deleted .git/logs and ORIG_HEAD for issue 12.

Nothing under environment/repo/ was touched.

### 6. If you added to the PR

I added to it rather than shrinking or replacing it, and stayed on the PR's own ground. The PR is about list patch behaviour and JSON serialisable chart config, so I added removal by position with mixed signs, a single value splice, serialising a collection of these objects, and grading the front end copy of the patch logic that the PR already changes. It still maps back to #2733, just larger.

### 7. Confirm requirements met

- [x] All requirements tested · [x] specified in instructions · [x] not LLM sounding · [x] not over prescriptive · [x] no leakage · [x] oracle matches · [x] PR not modified beyond what is allowed · [x] more than 10 f2p (17)

### 8. How long (in minutes) did it take you to complete the initial task rewrite only?

`[fill in]`

---

## What Makes This Task Difficult

One integer key now drives six different things a list can do: update in place, merge a dict into an element, overwrite element by element and append the overflow, splice ahead of a position, grow from the end when the position runs off it, and remove by position. Four of those already exist and have to keep working, so this is a rebuild rather than an addition, and the natural rebuild is exactly where the shipped oracle slipped and lost keys on a dict change. The arithmetic is easy to get wrong too: the position is the size of the key less one, an overshoot has to append instead of raising, and a batch of removals has to resolve against the list as it started or the earlier deletions move the later ones. The loop also changes the list while walking it, so the length has to be checked again each time. On top of that the work has to agree across four places, the Python logic, its front end twin, the new JsonProperty API, and the holder that serialises it, and proving the two sides behave the same is the real work.

---

## Comments for Reviewer

A few things are worth your own read.

First, two of my oracle edits are corrections rather than copies of the PR. One turns a stray second if into an elif so a dict change is no longer overwritten, and the other reorders the front end removal so every key resolves against the original list. I checked both in the built image but could not reach the network to compare against the PR itself, so if the upstream still has either of the old forms, treat these as deliberate fixes; shipping an oracle that breaks a stated rule would poison the reward.

Second, on the front end. The PR changes patch.ts, so I grade it. The image carries Node and esbuild, and the front end tests transpile and run the real file through a small Python subprocess, which keeps everything under pytest. Reverting patch.ts to base drops the reward to zero, so an untouched front end cannot pass. One caveat: a fully offline build with `docker build --network none` will not succeed, because apt and pip and npm all need the network at build time, the same as every task like this and in line with the task's original public build setting. Only the build reaches the network; the agent and verifier both run offline. Vendoring the whole toolchain to make the build airtight would run to hundreds of megabytes and is beyond what an EC should be doing here.

Third, there is a Plotly regression I left alone on purpose. The patch drops the Plotly branch from the holder, and a Plotly figure has a to_json that takes arguments, so it now warns and returns nothing instead of serialising. That is the PR's own behaviour, no test touches it, and fixing it would be inventing scope, but you may read the scope line differently.

A couple of smaller things. tests.patch only adds new functions, so the copy in the repo stays identical to base. There is no grade.py in tests/ because the compact harness embeds the grader inside test.sh. And the flask suffix on every test id comes from an automatically used fixture in the gui conftest, not from anything I wrote.

For validation I ran the whole thing from a fresh unzip. The unsolved repo scores zero, at 14 of 31, with all 17 fail to pass tests failing and the 14 pass to pass passing. The oracle scores 1.0 at 31 of 31 with nothing unexpected. Reverting just the front end file drops it back to zero as the four front end tests fail, and running the original oracle against the new tests also scores zero because the sibling check fires. tests.patch applies cleanly at the base commit, the git history is clean, and problem_statement.md matches the instruction.

---

## Final Comment and Handling Time

How much time would you estimate a senior engineer, familiar with the codebase, would take to solve this? 20 to 40 minutes

How long (in minutes) did it take you to review the initial task and determine its validity? `[fill in]`

How long (in minutes) did it take you to complete the initial task rewrite only? `[fill in]` (the same number as section 8)

How long (in minutes) did it take you to complete the additional questions on the form? `[fill in]` (the difficulty write up and the senior engineer estimate)

How long (in minutes) did it take you to complete all revisions? `[fill in]` (0 on a first submission that has not been sent back, and update it every time you complete a new revision)

How long (in minutes) did it take you to complete this entire submission? `[fill in]` (the four numbers above plus filling in the form itself)

---

## Quick Facts

| Field | Value |
| --- | --- |
| Verdict | Fixable |
| f2p / p2p / total | 17 / 14 / 31 |
| Files edited | instruction.md, problem_statement.md, golden.patch, frozen-requirements.txt, Dockerfile, tests.patch, config.json, task.toml (plus .git/logs and ORIG_HEAD deleted) |
| Repo files edited | none |
| Scope | expanded only |
| NOP / Oracle | reward 0 / reward 1.0 |
| Front end reverted | reward 0, so the front end is graded |
| Known limit | build needs the network, agent and verifier run offline |
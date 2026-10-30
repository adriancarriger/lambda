# Lambda

Run a team of coding agents on your own project: planning pods that turn an
idea into tickets, building pods that turn tickets into shipped code, and the
commands they share. Lambda's agents run on Claude Code, with your own Claude
account.

## Install

Two ways, the same Lambda:

- **The Mac app** (Apple silicon): everything in one download, including the
  tools agents need. See [Install the Mac app](#install-the-mac-app).
- **From npm**, on a Mac or Linux with Node 20 or later, tmux and git:

  ```sh
  npm i -g @adriancarriger/lambda
  lambda start
  lambda open
  ```

Either way, the first time you open Lambda it walks you through three steps
in your browser (or the app's window): connect Claude, pick or start a
project, and choose where tickets live.

## Install the Mac app

1. Download `Lambda-<version>-arm64.dmg` from the
   [latest Release](https://github.com/adriancarriger/lambda/releases/latest).
2. Open it and drag **Lambda** to **Applications**.
3. Open Lambda from Applications.

**The first time you open it**, macOS stops it with a warning that it
"cannot be opened because Apple cannot check it for malicious software" (or
that it "cannot verify the developer"). That's because these first releases
aren't signed by Apple yet. Lambda's source is public, in this repository.
To open it anyway, once:

1. Click **Done** (or **OK**) on the warning.
2. Open **System Settings → Privacy & Security**.
3. Scroll to **Security**. Next to the line about Lambda, click
   **Open Anyway**, then confirm with your password or Touch ID.
4. Click **Open** when macOS asks once more.

After that it opens like any other app. Until releases are signed, Lambda
can't update itself: when a new version is out, its menu-bar menu offers
**Download version X.Y.Z**, which opens that Release here.

Closing the window leaves Lambda in the menu bar (λ), and this Mac keeps
working for your agents. **Quit Lambda** from that menu stops everything.

## Commands

`lambda --help` lists them all. A few to start with:

| Command                          | What it does                                                    |
| -------------------------------- | --------------------------------------------------------------- |
| `lambda start`                   | Start Lambda, this computer's runner and the project's services |
| `lambda open`                    | Open Lambda in your browser, signed in                          |
| `lambda connect claude`          | Sign in to Claude for the agents (lasts a year)                 |
| `lambda connect linear` / `jira` | Use Linear or Jira for this project's tickets                   |
| `lambda init`                    | Write `lambda.json` for the project in this folder              |
| `lambda doctor`                  | Show where each command comes from, and what's set up           |
| `lambda upgrade`                 | Update to the newest version                                    |
| `lambda stop --all`              | Stop the project, the runner and Lambda                         |

## License

MIT

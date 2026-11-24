# 005 Panel

Open **Superagent** in the DeepSeek Harness Web sidebar to supervise the agent. The panel prioritizes work that needs a person, then system health and history. This document builds on [000 Philosophy](000-philosophy.md) through [004 Prompts](004-prompts.md).

## Three questions

Opening the panel answers three questions, in this order:

1. Does anything need me now?
2. Is the system healthy and doing the right things?
3. What is the history of one piece of work, from Trigger through Eval to Ticket?

## Tabs

The tabs follow the workflow: **Overview**, **Source**, **Trigger**, **Eval**, **Execution**, and **Settings**. Until repository and account setup succeeds, Overview shows what is missing and links to the relevant setting.

| Tab | Shows |
| --- | --- |
| Overview | Tickets needing action, system problems, activity counts for the last 24 hours, and Executor load. Each block links to its detailed page |
| Source | Source state, setup problems and non-zero counts. Filtered Triggers and dropped messages cover the same 24-hour window as Overview |
| Trigger | Threads filtered by Subscribed, Evaluating, New Triggers in 24 h, or All Threads. Each Thread shows its Triggers newest first, Decisions and Subscriptions |
| Eval | Decisions with their reason and matched rules |
| Execution | Executor state, Pause processing, and Tickets filtered by Open, Pending, Working, Waiting for a Trigger or Ended. Ticket details show actions, authorization, waiting Inputs, Subscriptions and Assignments |
| Settings | Sources, Eval, Execution, Prompts and Deployment. Each group includes its save history |

### Reading individual records

A dropped message links to its Ticket, or to its Thread when it has no Ticket. The Source page explains whether its conversation disappeared or the Source stopped listening to it.

A human follow-up still owned by an Executor is marked **Delivered to Ticket**, without an Eval. The Thread also shows hand-back reasons and context-only Subscriptions. **Evaluate again** can send that follow-up to Eval, or retry a Trigger with no effective judgement: one filtered by its Source, an unavailable Eval, or a delivered message with neither a non-stop Decision nor an Executor acknowledgement.

Ticket details show the originating Trigger, Decision and reason, scope and Policy version. Assignments and secondary details are folded below the immediate actions. **Retry** is available for failed Input delivery or a Ticket waiting for a person after a blocked or failed Report. Ended Tickets show outcomes such as **Pull request merged** or **Stopped by a person**.

## Settings groups

- **Sources:** one sub-tab for each Source the panel supports (GitLab, GitHub, POPO and Feishu), listed whether or not it is configured; a Source whose plugin is not enabled shows a notice instead of a card. A sub-tab holds the Source's top-level card: its switch, account fields and verified account facts. GitLab and GitHub then list one card per watched project or repository below it, each with its own switch, polling interval and receive-all switches (new Issues, pull requests or merge requests, comments and CI), and a **Delete** button that stops watching it after a confirmation. A repository or project runs only under its Source: switching the GitHub or GitLab Source off and saving switches every card below it off too (the save bar says how many), and while the Source is off those cards' switches and the add button are disabled until it is on again. Switching the Source back on leaves them off, to be switched on one by one. **Add project** and **Add repository** check access to the new one, save it as a new card and restart the application, which a removal does as well; Tickets and Threads already recorded stay readable. POPO and Feishu have only their top-level card; POPO's holds the `popo-robot` CLI, the chats and the receive switches. Polling and read limits are under Advanced.
- **Repositories:** a GitHub or GitLab repository's card also has a local clone. What each repository is and how they relate (roles, call chain) is not configured here; the main Session gets it from the knowledge the team connects. A request from GitHub or GitLab is submitted to its own repository only; a request from POPO or Feishu is judged by that knowledge and can be submitted to several repositories, one Ticket each, so none is missed.
- **Eval:** the Policy version and rules, followed by **On each Source** and the Eval settings. A Source kind with one account has one tab; a multi-instance kind (GitHub, GitLab) has one tab per watched repository or project, because who may originate work, the admission table and the bot list are set for each repository separately, while the account card carries no part. Each tab contains its allowed list, membership sync, admission table and bot list. Sync runs at startup and on **Sync now**. The admission table distinguishes receiving scope, sender membership and whether the message addresses the agent. Eval settings select the accept mode, timeout and assessment model.
- **Execution:** worker model, concurrency, directory root, prepare command and blocked commands, and a disclosure listing every watched repository with its local clone (change it on the repository's card on the Sources page). Ticket directories sit under the root, one directory for each repository. Clicking an available variable inserts it into the prepare command. A prepare command is parsed with `sh -n` when it is saved, and one that is not valid shell is refused with the parser's message instead of failing every new Ticket.
- **Prompts:** **Edit** changes team sections, built-in parts and skills. **Full prompt** shows the assembled text and compares it with saved text or defaults. **History** lists versions. Edited built-in parts are marked changed and can be reset; templates list their required placeholders.

  An upgrade that changes an overridden default marks it **Default updated** (默认内容已更新). The panel compares the old and new defaults above the team's text. If the old default was not recorded, it compares the team's text with the new default instead. Choose **Keep my text** or **Use the new default**. Overrides for removed parts are listed below the tab bar and dropped on the next save.
- **Deployment:** startup problems with **Check again**, the state directory and machine limits. Saved limits apply without restart. The DeepSeek Harness Plugin Manager exposes the same page.

## Search

The header search finds Triggers by text, id, Feishu message id or a stored link, such as a GitHub comment URL. A Feishu link missing from the original message becomes searchable only after the host reads it during the current process lifetime.

Search also finds Threads by references such as `#12` or a GitHub URL, and Tickets by title or a matching Thread.

## Principles

1. **Focus on what matters.** Every element answers one of the three questions, or it is removed. A number appears only when it changes what the supervisor does.
2. **Precise definitions.** Categories have checkable definitions, are mutually exclusive and cover every case, as the Ticket stages do. A label says whom a row waits for and what it needs, not an internal status code.
3. **One place per concept.** Source state belongs in Source; Threads and Triggers in Trigger; Decisions in Eval; Tickets in Execution. Settings are grouped by the concept they configure. Overview summarizes these pages and links to them instead of becoming another detailed view.
4. **Domain structure.** The panel uses the domain terms. Internal identifiers appear only in folded details, and names replace identifiers where they can be resolved.
5. **Honest state.** A count equals the length of the list it links to, and no state contradicts another fact.
6. **Quiet by default.** Healthy states take no extra space. Problems must be actionable; a one-off network error is not enough. Rows needing a person offer their action directly. Keep page explanations to one sentence and put further detail in the (?) tooltip. Destructive actions require confirmation.
7. **Consistent controls.** Use DeepSeek Harness design tokens and control behavior. The same information should look the same throughout the panel. Each settings block has one save bar, visible only while changes exist, a save runs or a save fails.

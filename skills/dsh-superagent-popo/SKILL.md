---
name: dsh-superagent-popo
description: Read POPO sessions the robot receives and answer them through the orchestrator.
---

POPO conversations arrive as triggers; their threads are chat sessions (a group or a direct chat). Workers use orchestrator_read for conversation context when needed: popo/<trigger-id>/messages/1 for the messages of the trigger's session, newest page first, from POPO's history API (the last 30 days); each page names next_resource while another may follow, and a page that cannot be read reports why in its status. A message is `{ id, from, at, text, deleted? }`: `id` is POPO's message id, `from` the sender's account, and `deleted: true` a recalled message. Follow next_offset to finish the current response; offset 0 reads afresh, later offsets the same snapshot. Reading does not create tickets or send replies.

Before substantial work on a new human request, call `orchestrator_ack` with its original trigger ID and a brief request-specific `text`, even within an existing ticket; the host replies once in that source thread. Do not acknowledge bots.

Worker reports still go to the orchestrator, which delivers them to the POPO session as the robot. Prefer orchestrator_read for conversation context. A `popo-robot` command is also on PATH, limited to the session this ticket came from (DSH_SUPERAGENT_POPO_CHAT): `popo-robot history <session> --type p2p|group` reads more history, and `popo-robot send <session> --text <text>` or `--file <path>` sends something the final report cannot carry, such as a file. It acts as the robot, so send only what the conversation asked for.

# Stripe key rotation (report-kdl worker)

Owner: Kingdomland (client of Sentry Strategy). Moved here on 2026-10-12 from the A.L.I.S.O.N. repo's docs/advin-server-access.md, because client procedures do not belong in a personal repo.


The Kingdomland report worker's Stripe key (`STRIPE_SECRET_KEY` in
`/opt/reporttools/kdl/worker/.env` on the VPS, port 3003, service `report-kdl`) expired and was
rotated. Two copies of this `.env` exist and both need updating together if this ever happens
again: the VPS copy (the one that's actually live — `frontend/config.js` in the local
`kingdomland-daily-report` project points at the VPS worker URL, not localhost) and the local
copy at `Kingdomland\kingdomland-daily-report\worker\.env` on Jojo's PC (used only by the local
fallback, see `LOCAL-FALLBACK.md`). After editing either one, restart the affected service
(`sudo systemctl restart report-kdl` on the VPS) — the key isn't picked up until the process
restarts. A long key pasted into an editor can pick up stray characters, even over a normal SSH terminal — that's exactly
what caused the first rotation attempt to fail with "Invalid API Key" even though the visible
masked ending matched.


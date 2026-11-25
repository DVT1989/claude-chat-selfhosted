# Changelog

## 2026-11-25 (gedeelde projecten, kleine functies)
- Ongelezen-badge ook op het tabje Projecten (zichtbaar vanuit Chats); push naar andere leden en badge per project bestonden al, eigen berichten tellen niet mee.
- Projectchats staan niet meer in de algemene chatlijst, alleen onder hun project.
- Lightbox voor afbeeldingen in de chat (bijlagen en markdown): Esc, klik buiten of sluitknop; fade 200 ms, geen animatie bij verminderde beweging. Alleen frontend.

## 2026-11-25 (gedeelde projecten, backend)
- Gedeelde projecten: geen eigenaar-rechten meer, rechten volgen lidmaatschap (`project_members`, de maker is het eerste lid; migratie 012 vult bestaande projecten). `projects.user_id` blijft technisch anker.
- Groepschat: kleur per lid, `messages.user_id`, leesstatus (`conversation_reads`), typ-indicator, pushmeldingen aan andere leden, vraagwachtrij per vrager.
- Agents per project (`project_agents`, `project_agent_users`), projectgeheugen met `geheugen.md`-sync, projectkoppelingen, activiteitenlog (013). Runs gebruiken de eigen accounts van de vrager (bestaande pickAccount).
- Bestaande projecten en chats blijven werken. Tests: `sharedProjects.test.ts`.

## 2026-11-25
- Microsoft 365 is opt-in per agent: `config.agent_access` op de m365-connector (agent id -> read | write; geen vinkje = geen toegang). De eigen hoofd-Claude houdt volledige toegang.
- PreToolUse-hook `backend/src/hooks/m365Guard.ts`: subagents zonder toegang worden geblokkeerd op `.m365-*.token` en graph.microsoft.com; read-only agents mogen geen POST/PUT/PATCH/DELETE.
- `PUT /m365/tenants/:id/access`; prompt-regels (readOnlyAgents, noAccessAgents); Lezen-agents krijgen een token met alleen leesrechten (valt terug op de gewone set als de tenant daar geen toestemming voor heeft).
- Instellingen > Agents: paneel Koppelingen per agent (lijst met schakelaar, niveau Lezen of Lezen en schrijven, standaard Lezen). Instellingen > Microsoft 365 toont alleen agents met toegang.
- Migratie bij opstarten (eenmalig): alle bestaande agents van de eigenaar krijgen Lezen op bestaande tenants, zodat niemand ineens zonder toegang valt.

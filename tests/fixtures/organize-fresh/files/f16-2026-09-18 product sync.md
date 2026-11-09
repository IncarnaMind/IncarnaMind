# Product sync - Sept 18

**Attendees:** Priya, Marcus, Elena, Tomasz, Jo (notes)
**Absent:** Kwame (travelling)

## Agenda
1. Beta feedback from week 2
2. Onboarding drop-off
3. Release date for 0.9
4. Hiring

## Notes

**Beta feedback.** 31 of 40 testers are still active. The top three complaints are (a) import is slow for files over 50 MB, (b) search results don't show where in the document the match is, (c) no dark mode. Marcus thinks (a) is a quick fix, we are reading the whole file before showing progress.

**Onboarding.** 38% of new users quit before creating their first project. Elena showed a funnel: most leave on the "pick a template" screen. Idea: skip the screen and start from a blank project, offer templates afterwards. Tomasz worried about losing the template upsell; agreed to try it on 20% of new signups for two weeks.

**Release 0.9.** Target is Oct 6. Blockers: the import fix, a crash on Windows when the path has non-ASCII characters (Priya reproduced it), and the licence check. If the Windows crash isn't fixed by Oct 1 we slip a week.

**Hiring.** Two candidates for the support role this week; Jo to schedule final interviews. Backend engineer role still open, no strong candidates.

## Decisions
- Ship blank-project onboarding as an A/B test (20%) starting Monday
- Freeze features for 0.9 on Sept 25; bug fixes only after that
- Dark mode moves to 1.0

## Action items
- [ ] Marcus: streaming import with progress bar (by Sept 24)
- [ ] Priya: fix Windows non-ASCII path crash (by Oct 1)
- [ ] Elena: set up the onboarding A/B test (by Sept 21)
- [ ] Jo: schedule support-role interviews, post backend job again
- [ ] Tomasz: draft the release notes for 0.9

Next sync: Sept 25, 10:00.

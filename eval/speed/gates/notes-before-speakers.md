# The gate for starting a call's notes while its speakers are told apart (#2773)

Written and committed on 2026-11-08, before any run it gates, after `notes-without-thinking.md` failed on both models. After Stop, a call's notes wait for the speaker pass (#138) before they start: 6–8 s for a one-minute call on today's main (`b2ae19bf8`), and about 8 minutes for an hour (#1581). They wait so that the Citations they write name the final speakers. In a call with one voice on the other side the pass renames no one, so the wait buys nothing there.

The change: once a call's Transcript is saved, its words are final, and its notes start at once while the pass runs. Nothing is written until the pass has ended. If the pass renamed any line, what was made is dropped and the notes start again from the renamed Transcript, as today. A recording of a room, where the pass always names the voices, waits as today. So the notes that go into the Note are always made from the Transcript as the pass left it: the same input, prompt and model as today's.

## The runs

The test build of today's main and of the branch (`electron-vite build --mode test`), each with Chromium's fake capture playing the issue's two synthetic calls (an English sales call of 53 s, a Chinese one of 62 s, made with macOS `say`) as the other side's sound, transcribed on this computer by the real engines, the speaker pass included, and stopped 3 s after the last words. On Claude Haiku 5.5 and DeepSeek V4.1 Flash 1017 (`deepseek-flash`), as the User's Answers model, twice per model and language on each build, the builds taking turns. The 15-minute load is under 24, said beside each run.

## The guards

On each model and language:

- **The same notes.** Claude Sonnet 5.5 judges each Note's text against the call's facts below and against the Transcript's words. The branch's notes give as many of the facts as main's, summed over both runs, and the judge finds no sentence in them that the Transcript doesn't say where main's had none.
- **The final speakers.** Every Citation in the branch's notes is found, and names the speaker its line has in the saved Transcript.
- **One set of notes.** One request writes them when the pass renames no one; none is written twice; the fill ends filled, not partly.

And in the core's tests: a call whose pass renames no one writes once, after the pass; a call whose pass renames a line is filled again from the renamed Transcript, its Citations naming the new speakers; a room recording sends nothing before the pass ends; a quit while the notes are made before the pass ends fills them in once the pass has run at the next start, writing nothing twice.

The call's facts, as in `notes-without-thinking.md`:

- English call: Enterprise is 45 dollars a seat a month with single sign-on included; annual billing takes 10% off, 40.50 dollars a seat; whether the data can stay in the European region is open, and Maren checks with the security team and emails by Thursday; the trial starts on 1 December; Maren sends the contract draft tomorrow; whether the API has rate limits is open, and Maren finds out.
- Chinese call: 企业版每个席位每月三百元，含单点登录；按年付费打九折，每个席位每月二百七十元；数据能否留在国内未定，林晓雯（转写可能写作林小文）与安全团队确认，周四前邮件回复；试用十二月一号开始；林晓雯明天发合同草稿；接口有无调用次数限制未定，回头再确认。

## Faster, or it isn't shipped

The notes are done sooner on the branch than on main, on the median of each model and language.

## Spend

Within what is left of this work's $5, counted by the app's own meter and the judge's catalog price.

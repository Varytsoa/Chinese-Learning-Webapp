# Chinese Learning Webapp

A local-first Chinese study app built with React, Vite, and TypeScript. It stores study data in the browser with IndexedDB and does not require authentication, a backend, or cloud sync.

## Features

- Import and read Chinese text with Simplified or Traditional characters.
- Segment words with clickable dictionary lookups, pinyin, HSK labels, and HSK text colors.
- Add vocabulary to the global Study List and assign it to multiple custom lists.
- Generate recognition and recall flashcards with duplicate protection.
- Review cards with Again, Hard, Good, and Easy spaced-repetition ratings.
- Translate full texts and individual sentences with cached local results.
- Track reading history, dashboard progress, review activity, and HSK coverage.
- Export and import all application data as JSON.
- Use Light, Dark, or System themes.

## Run locally

Install dependencies:

```bash
npm install
```

Start the Vite development server:

```bash
npm run dev
```

Open the app at:

**[http://127.0.0.1:5173/](http://127.0.0.1:5173/)**

## Build

```bash
npm run build
```

The production output is generated in `dist/`. It is intentionally ignored by Git because it can be recreated from the source with `npm run build`.

## Local data

Study data is stored locally in IndexedDB. The app does not include an account system, backend, or automatic cloud synchronization. Use **Settings → Export JSON** to create a portable backup.

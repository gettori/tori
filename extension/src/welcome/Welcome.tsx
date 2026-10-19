import { ConnectionRow, Icon, Row, ShortcutRow } from "../options/rows";

const DOCS = "https://gettori.app/docs/browser/extension/";

export default function Welcome() {
  return (
    <main>
      <header>
        <h1>Tori</h1>
        <p>The browser extension is installed</p>
      </header>
      <section class="card" aria-label="Getting started">
        <ConnectionRow />
        <Row
          id="badge"
          label="The toolbar icon"
          hint="On a tab served by a Tori worktree, the icon shows a dot in its space's colour, and hovering it names the branch and the project. No dot means the tab is not a worktree, or Tori cannot be reached; hovering says which."
          icon={
            <Icon>
              <circle cx="8" cy="8" r="5.5" />
              <circle cx="11.5" cy="4.5" r="1.5" />
            </Icon>
          }
        />
        <ShortcutRow />
        <Row
          id="docs"
          label="Docs"
          hint="What a pick sends, every permission and why it is there."
          icon={
            <Icon>
              <path d="M3.5 2.5h6l3 3v8h-9zM9.5 2.5v3h3" />
            </Icon>
          }
        >
          <button type="button" class="secondary" onClick={() => void chrome.tabs.create({ url: DOCS })}>
            Open
          </button>
        </Row>
      </section>
    </main>
  );
}

import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { mockIPC } from "@tauri-apps/api/mocks";
import { userEvent, within } from "storybook/test";
import ForgeSection from "./ForgeSection";
import type { AuthState, ForgeAccount, ForgeHost, ForgeProvider, SignInRoutes } from "../../../../utils/forgeTypes";

const signedIn = (login: string): AuthState => ({ kind: "signedIn", login });

function account(host: string, login: string, auth: AuthState, provider: ForgeProvider = "github"): ForgeAccount {
  return {
    id: `${host.replace(/\./g, "-")}-${login}`,
    provider,
    baseUrl: `https://${host}`,
    login,
    label: login,
    expiresAt: null,
    rejectedAt: auth.kind === "suspect" ? Date.UTC(2026, 8, 12, 12) / 1000 : null,
    scopes: provider === "github" ? ["repo", "workflow"] : null,
    source: "token",
    orgAccess: [],
    auth,
  };
}

function host(name: string, accounts: ForgeAccount[], extra: Partial<ForgeHost> = {}): ForgeHost {
  return { host: name, accounts, gitCredentials: false, gitEverywhere: false, defaultAccount: null, appId: null, ...extra };
}

function routes(baseUrl: string, provider: ForgeProvider): SignInRoutes {
  const url = baseUrl.startsWith("https://") ? baseUrl : `https://${baseUrl}`;
  const name = new URL(url).host;
  const scopes = provider === "github" ? ["repo", "workflow"] : ["api", "write_repository"];
  return {
    host: name,
    baseUrl: url,
    deviceFlow: name === "gitlab.com",
    scopes,
    tokenUrl: `${url}/-/user_settings/personal_access_tokens`,
    appId: null,
  };
}

/** How the browser sign-in ends, for the stories that need it to end badly.
 *  Both failures come back from the poll: `forge_sign_in_start` is what issues
 *  the code, so a start that threw would leave no card to fail. */
type Device = "waits" | "expires" | "denied";

function stubHost(hosts: ForgeHost[], device: Device = "waits") {
  mockIPC((cmd, args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    switch (cmd) {
      case "forge_accounts":
        return hosts;
      case "forge_sign_in_start": {
        const r = routes(a.baseUrl as string, a.provider as ForgeProvider);
        if (!r.deviceFlow) return { kind: "token", routes: r };
        return {
          kind: "browser",
          routes: r,
          prompt: {
            userCode: "5BB3-E406",
            verificationUri: "https://gitlab.com/oauth/device",
            expiresInSecs: 900,
            intervalSecs: 1,
          },
        };
      }
      case "forge_device_poll":
        switch (device) {
          case "expires":
            return { kind: "expired", code: "expired_token" };
          case "denied":
            return { kind: "denied", code: "access_denied" };
          default:
            return { kind: "pending", nextIntervalSecs: 60 };
        }
      case "set_settings":
        return a.settings;
      default:
        return null;
    }
  });
}

const meta = {
  title: "Settings/ForgeSection",
  component: ForgeSection,
  decorators: [
    (Story) => (
      <div style={{ width: "720px", padding: "24px", background: "var(--canvas-card)" }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ForgeSection>;

export default meta;
type Story = StoryObj<typeof meta>;

export const State01Empty: Story = {
  render: () => {
    stubHost([]);
    return <ForgeSection />;
  },
};

export const State02OneGithubAccount: Story = {
  render: () => {
    stubHost([host("github.com", [account("github.com", "octocat", signedIn("octocat"))])]);
    return <ForgeSection />;
  },
};

export const State03TwoHosts: Story = {
  render: () => {
    stubHost([
      host(
        "github.com",
        [account("github.com", "octocat", signedIn("octocat")), account("github.com", "octocat-review", signedIn("octocat-review"))],
        { gitCredentials: true, defaultAccount: "github-com-octocat" },
      ),
      host("gitlab.com", [account("gitlab.com", "a.mehta", signedIn("a.mehta"), "gitlab")]),
    ]);
    return <ForgeSection />;
  },
};

export const State04Rejected: Story = {
  render: () => {
    stubHost([
      host("ghe.example.com", [account("ghe.example.com", "j.okafor", { kind: "suspect", login: "j.okafor" })]),
    ]);
    return <ForgeSection />;
  },
};

/** Relative, not fixed: the row reads the clock, so a pinned date would drift
 *  into the past and both rows would render the same state. */
const inDays = (days: number) => Math.floor(Date.now() / 1000 + days * 86_400);

export const State05TokenExpiry: Story = {
  render: () => {
    stubHost([
      host("github.com", [
        { ...account("github.com", "octocat", signedIn("octocat")), expiresAt: inDays(4) },
        { ...account("github.com", "octocat-ci", signedIn("octocat-ci")), expiresAt: inDays(-2) },
      ]),
    ]);
    return <ForgeSection />;
  },
};

export const State06BlockedOrg: Story = {
  render: () => {
    stubHost([
      host("github.com", [
        {
          ...account("github.com", "octocat", signedIn("octocat")),
          orgAccess: [
            { org: "acme", url: "https://github.com/orgs/acme/sso?authorization_request=AR_kgD" },
          ],
        },
      ]),
    ]);
    return <ForgeSection />;
  },
};

export const State07Picker: Story = {
  render: () => {
    stubHost([]);
    return <ForgeSection />;
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByText("Another host..."));
    await canvas.findByText("Connect a host");
  },
};

export const State08Waiting: Story = {
  render: () => {
    stubHost([]);
    return <ForgeSection />;
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByText("Another host..."));
    await userEvent.click(await canvas.findByText("gitlab.com"));
    await userEvent.click(await canvas.findByText("Continue"));
    await canvas.findByText("5BB3");
  },
};

export const State09TokenPaste: Story = {
  render: () => {
    stubHost([], "denied");
    return <ForgeSection />;
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByText("Another host..."));
    await userEvent.click(await canvas.findByText("gitlab.com"));
    await userEvent.click(await canvas.findByText("Continue"));
    await userEvent.click(await canvas.findByText("Paste a token instead"));
    await userEvent.type(await canvas.findByLabelText("Personal access token"), "glpat-xxxxxxxxxxxxxxxxxxxx");
  },
};

export const State10SelfManaged: Story = {
  render: () => {
    stubHost([]);
    return <ForgeSection />;
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByText("Another host..."));
    await userEvent.click(await canvas.findByText("GitLab, self-managed"));
    await userEvent.click(await canvas.findByText("Continue"));
    await userEvent.type(await canvas.findByLabelText("Host URL"), "https://gitlab.acme.dev");
  },
};

export const State11Error: Story = {
  render: () => {
    stubHost([], "expires");
    return <ForgeSection />;
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByText("Another host..."));
    await userEvent.click(await canvas.findByText("gitlab.com"));
    await userEvent.click(await canvas.findByText("Continue"));
    await canvas.findByText("Start again", {}, { timeout: 5000 });
  },
};

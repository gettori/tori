import { describe, it, expect, vi } from "vite-plus/test";
import { render, screen, fireEvent, waitFor, within } from "@solidjs/testing-library";
import Root from "./Root";
import { TopicForm } from "./Organize";
import { TopicScreen } from "./Screens";
import { joinableTopics, type Space, type Topic, type TopicMember, type Tree } from "./tree";
import type { RemoteClient } from "./remote";

function client() {
  const request = vi.fn(async () => null);
  const fake = {
    status: () => "open",
    update: () => null,
    generation: () => 1,
    request,
    subscribe: () => () => {},
  } as unknown as RemoteClient;
  return { fake, request };
}

const project = (name: string, path: string) => ({ name, path, units: [] });
const SAGA: Space = {
  name: "saga",
  path: "/s",
  icon: null,
  color: null,
  projects: [project("api", "/s/api"), project("web", "/s/web")],
};
const HOME: Space = { name: "Personal", path: "/p", icon: null, color: null, projects: [project("blog", "/p/blog")] };

const member = (repoPath: string, order = 0): TopicMember => ({
  repoPath,
  displayName: repoPath.split("/").pop()!,
  worktreePath: null,
  order,
});
const topic = (id: string, members: TopicMember[], space?: string): Topic => ({
  id,
  name: id,
  branch: `feat/${id}`,
  members,
  ...(space ? { space } : {}),
});

const CHECKOUT = topic("Checkout", [member("/s/api"), member("/s/web", 1)], "saga");
const LAUNCH = topic("Launch", [member("/s/web"), member("/p/blog", 1)]);
const NOTES = topic("Notes", [member("/p/blog")], "Personal");
const TREE: Tree = { spaces: [SAGA, HOME], topics: [LAUNCH, NOTES, CHECKOUT] };

function mountRoot(tab: "projects" | "topics") {
  const { fake } = client();
  const onNewTopic = vi.fn();
  render(() => (
    <Root
      client={fake}
      tree={TREE}
      space={SAGA}
      tab={tab}
      live={() => []}
      notice={null}
      onProject={() => {}}
      onTopic={() => {}}
      onUnit={() => {}}
      onSession={() => {}}
      onSettings={() => {}}
      onSpaces={() => {}}
      onNewTopic={onNewTopic}
    />
  ));
  return onNewTopic;
}

describe("Topics on the phone", () => {
  it("lists a space's own Topics above its projects, with a + for a new one there", () => {
    const onNewTopic = mountRoot("projects");
    const topics = screen.getByText(/^Topics/);
    expect(
      topics.compareDocumentPosition(screen.getByText(/^Projects/)) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByText("Checkout")).toBeTruthy();
    expect(screen.getByText("api, web")).toBeTruthy();
    expect(screen.queryByText("Launch")).toBeNull();
    expect(screen.queryByText("Notes")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "New Topic in saga" }));
    expect(onNewTopic).toHaveBeenCalled();
  });

  it("lists only global Topics on the Topics tab, each naming its spaces", () => {
    mountRoot("topics");
    expect(screen.getByText(/all spaces/)).toBeTruthy();
    expect(screen.getByText("Launch")).toBeTruthy();
    expect(screen.getByText("saga · Personal")).toBeTruthy();
    expect(screen.queryByText("Checkout")).toBeNull();
    expect(screen.queryByText("Notes")).toBeNull();
  });

  it("offers a worktree its space's Topics first, then the global ones", () => {
    expect(joinableTopics(TREE, "/s/api").map((t) => t.id)).toEqual(["Checkout", "Launch"]);
    expect(joinableTopics(TREE, "/p/blog").map((t) => t.id)).toEqual(["Notes", "Launch"]);
  });
});

describe("TopicForm", () => {
  function mountForm() {
    const { fake, request } = client();
    render(() => <TopicForm client={fake} spaces={[SAGA, HOME]} space="saga" onSaved={() => {}} onDone={() => {}} />);
    return request;
  }
  const pick = (name: string, mode: string) =>
    fireEvent.click(within(screen.getByRole("group", { name })).getByRole("button", { name: mode }));

  it("makes a Topic in the space on a branch from its name", async () => {
    const request = mountForm();
    expect(screen.getByText("Projects in saga")).toBeTruthy();
    expect(screen.queryByText("blog")).toBeNull();
    fireEvent.input(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Ship It" } });
    pick("api", "Worktree");
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(request).toHaveBeenCalled());
    expect(request).toHaveBeenCalledWith("topic.new", {
      name: "Ship It",
      branch: "ship-it",
      members: [{ repoPath: "/s/api", mode: "worktree" }],
      space: "saga",
    });
  });

  it("lists every space's projects for a Topic in Topics, and sends no space", async () => {
    const request = mountForm();
    fireEvent.click(within(screen.getByRole("group", { name: "Where" })).getByRole("button", { name: "Topics" }));
    expect(screen.getByRole("heading", { name: "saga" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Personal" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Projects in saga" })).toBeNull();
    fireEvent.input(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Wide" } });
    pick("blog", "Reference");
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(request).toHaveBeenCalled());
    expect(request).toHaveBeenCalledWith("topic.new", {
      name: "Wide",
      branch: "wide",
      members: [{ repoPath: "/p/blog", mode: "reference" }],
    });
  });
});

describe("TopicScreen", () => {
  function mountTopic(t: Topic) {
    const { fake, request } = client();
    render(() => (
      <TopicScreen
        client={fake}
        topic={t}
        tree={TREE}
        live={() => []}
        crew={() => ({ sessions: new Set<string>(), worktrees: new Set<string>() })}
        autopilotOn={false}
        onUnit={() => {}}
        onOpen={() => {}}
        onBack={() => {}}
        onChanged={() => {}}
      />
    ));
    return request;
  }
  const menu = (item: string) => {
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    fireEvent.click(screen.getByRole("menuitem", { name: item }));
  };

  it("names its space and adds only that space's repositories", () => {
    mountTopic(topic("Solo", [member("/s/api")], "saga"));
    expect(screen.getByText("saga", { selector: "p" })).toBeTruthy();
    menu("Add a repository");
    const sheet = screen.getByRole("dialog", { name: "Add repository to Solo" });
    expect(within(sheet).getByText("web")).toBeTruthy();
    expect(within(sheet).queryByText("blog")).toBeNull();
  });

  it("moves to a space that holds every member", async () => {
    const request = mountTopic(topic("Solo", [member("/s/api")]));
    menu("Move to");
    fireEvent.click(within(screen.getByRole("dialog", { name: "Move Solo" })).getByText("saga"));
    await waitFor(() => expect(request).toHaveBeenCalledWith("topic.space", { topic_id: "Solo", space: "saga" }));
  });
});

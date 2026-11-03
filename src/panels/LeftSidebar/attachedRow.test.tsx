import { describe, it, expect } from "vite-plus/test";
import { render, screen } from "@solidjs/testing-library";
import { ProjectRow } from "./SidebarRows";

describe("an attached folder's project row", () => {
  it("wears the badge, names its full path and keeps the parent for the hover", () => {
    render(() => (
      <ProjectRow
        name="acme-site"
        icon={<span />}
        attached={{ parent: "~/Documents/clients", full: "~/Documents/clients/acme-site" }}
        end={<span>3</span>}
      />
    ));
    expect(screen.getByRole("img", { name: "Attached folder" })).toBeTruthy();
    expect(screen.getByText("acme-site").getAttribute("title")).toBe("~/Documents/clients/acme-site");
    expect(screen.getByText("~/Documents/clients")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
  });

  it("trades every mark for one alert when the folder is missing", () => {
    render(() => (
      <ProjectRow
        name="thesis"
        icon={<span />}
        attached={{ parent: "/Volumes/Archive", full: "/Volumes/Archive/thesis" }}
        missing
        end={<span>3</span>}
      />
    ));
    expect(screen.getByRole("img", { name: "Folder missing" })).toBeTruthy();
    expect(screen.queryByText("3")).toBeNull();
  });

  it("has no badge and no path on a project from a space", () => {
    render(() => <ProjectRow name="api" icon={<span />} />);
    expect(screen.queryByRole("img", { name: "Attached folder" })).toBeNull();
    expect(screen.getByText("api").getAttribute("title")).toBeNull();
  });
});

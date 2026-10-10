import { describe, it, expect, vi } from "vite-plus/test";
import { render, screen, fireEvent, waitFor } from "@solidjs/testing-library";
import { expectNoAxeViolations } from "../../test/axe";

// `convertFileSrc` reads Tauri's injected internals, which a test has none of,
// and the assertions only need the chosen path to reach the preview.
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://${path}`,
}));

const { default: ProjectIconPicker } = await import("./ProjectIconPicker");

// The payload says which source won by which key is present, so the assertions
// read it rather than the highlight wherever they can.

type Props = Parameters<typeof ProjectIconPicker>[0];

function open(props: Partial<Omit<Props, "onChoose">> = {}) {
  const onChoose = vi.fn();
  const onPickFile = vi.fn(() => Promise.resolve<string | null>("/tmp/logo.png"));
  render(() => (
    <ProjectIconPicker
      seed="/Users/x/Projects/tori"
      icon={null}
      iconFile={null}
      favicon={null}
      busy={false}
      onChoose={onChoose}
      onPickFile={onPickFile}
      {...props}
    />
  ));
  const search = () => screen.getByLabelText("Search icons") as HTMLInputElement;
  const tiles = () => Array.from(screen.getByRole("group", { name: "Project icon" }).querySelectorAll("button"));
  const mode = (name: string) => screen.getByRole("button", { name });
  // The grid rests on a short random shelf, so a named glyph is reached the way
  // a user reaches one: through the field beside it.
  const pick = (name: string) => {
    fireEvent.input(search(), { target: { value: name } });
    fireEvent.click(tiles().find((b) => b.getAttribute("aria-label") === name)!);
  };
  const dropzone = () => screen.getByRole("button", { name: /SVG, PNG or ICO/ });
  return { onChoose, onPickFile, search, tiles, mode, pick, dropzone };
}

describe("ProjectIconPicker", () => {
  it("says what the automatic option will actually show", () => {
    open();

    expect(screen.getByText("Derived from the folder")).toBeTruthy();
  });

  it("says the automatic option is the favicon when there is one", () => {
    open({ favicon: "/tmp/favicon.ico" });

    expect(screen.getByText("The project's own favicon")).toBeTruthy();
  });

  it("starts on automatic when nothing is stored", () => {
    const { mode } = open();

    expect(mode("Automatic").getAttribute("aria-pressed")).toBe("true");
  });

  it("starts on the stored glyph", () => {
    const { tiles, mode } = open({ icon: "Rocket" });

    expect(mode("Pick an icon").getAttribute("aria-pressed")).toBe("true");
    expect(
      tiles().some((b) => b.getAttribute("aria-label") === "Rocket" && b.getAttribute("aria-pressed") === "true"),
    ).toBe(true);
  });

  it("starts on the stored image, previewing it", () => {
    const { mode } = open({ iconFile: "/store/icon.png" });

    expect(mode("Upload").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("Uploaded image")).toBeTruthy();
    expect(document.querySelector("img")?.getAttribute("src")).toBe("asset:///store/icon.png");
  });

  it("saves automatic as an empty choice", () => {
    const { onChoose, mode } = open({ icon: "Rocket" });

    fireEvent.click(mode("Automatic"));

    expect(onChoose).toHaveBeenCalledWith({});
  });

  it("saves a picked glyph by name", () => {
    const { onChoose, mode, pick } = open();

    fireEvent.click(mode("Pick an icon"));
    pick("Rocket");

    expect(onChoose).toHaveBeenCalledWith({ icon: "Rocket" });
  });

  it("saves nothing for moving the strip alone", () => {
    const { onChoose, mode } = open();

    fireEvent.click(mode("Pick an icon"));
    fireEvent.click(mode("Upload"));
    fireEvent.click(mode("Automatic"));

    expect(onChoose).not.toHaveBeenCalled();
  });

  it("saves an uploaded image by its source path", async () => {
    const { onChoose, mode, dropzone } = open();

    fireEvent.click(mode("Upload"));
    fireEvent.click(dropzone());
    await waitFor(() => expect(screen.getByText("logo.png")).toBeTruthy());

    expect(onChoose).toHaveBeenCalledWith({ file: "/tmp/logo.png" });
  });

  it("does not re-upload the image it already has", async () => {
    const onPickFile = vi.fn(() => Promise.resolve<string | null>("/store/icon.png"));
    const { onChoose, dropzone } = open({ iconFile: "/store/icon.png", onPickFile });

    fireEvent.click(dropzone());
    await waitFor(() => expect(onPickFile).toHaveBeenCalledTimes(1));

    expect(onChoose).not.toHaveBeenCalled();
  });

  it("asks the host for the file, once, however fast the zone is hit", async () => {
    const { onPickFile, mode, dropzone } = open();

    fireEvent.click(mode("Upload"));
    fireEvent.click(dropzone());
    fireEvent.click(dropzone());
    await waitFor(() => expect(screen.getByText("logo.png")).toBeTruthy());

    expect(onPickFile).toHaveBeenCalledTimes(1);
  });

  it("states the upload limits in the zone they apply to", () => {
    const { mode } = open();

    expect(screen.queryByText(/SVG, PNG or ICO/)).toBeNull();

    fireEvent.click(mode("Upload"));

    expect(screen.getByText("SVG, PNG or ICO, up to 2 MB, square works best")).toBeTruthy();
  });

  it("filters the glyph grid", () => {
    const { search, tiles, mode } = open();

    fireEvent.click(mode("Pick an icon"));
    const shelf = tiles().length;
    fireEvent.input(search(), { target: { value: "rocket" } });

    expect(tiles().length).toBeLessThan(shelf);
    expect(tiles()[0].getAttribute("aria-label")).toBe("Rocket");
  });

  it("ignores a choice while it is already working", () => {
    const { onChoose, mode, pick } = open({ busy: true });

    fireEvent.click(mode("Pick an icon"));
    pick("Rocket");

    expect(onChoose).not.toHaveBeenCalled();
  });

  it("has no accessibility violations", async () => {
    open({ favicon: "/tmp/favicon.ico" });

    await expectNoAxeViolations(document.body);
  });

  it("has no accessibility violations in the upload mode", async () => {
    const { mode } = open();

    fireEvent.click(mode("Upload"));

    await expectNoAxeViolations(document.body);
  });
});

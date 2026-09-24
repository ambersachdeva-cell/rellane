import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TelegramPanel, type TelegramKnock, type TelegramPanelProps } from "./TelegramPanel.js";

const DEFAULT_MAY_DO: readonly string[] = [
  "Ask questions about current tasks",
  "Check status of background work",
  "Stop ongoing runs",
  "Receive notifications when work finishes",
];

const DEFAULT_MAY_NOT_DO: readonly string[] = [
  "Cannot approve anything.",
  "Cannot change a file.",
  "Cannot send a message as you.",
  "Cannot grant a permission.",
];

function createProps(overrides: Partial<TelegramPanelProps> = {}): TelegramPanelProps {
  const base: TelegramPanelProps = {
    link: { state: "off" },
    knocks: [],
    now: 1_700_000_000_000,
    mayDo: DEFAULT_MAY_DO,
    mayNotDo: DEFAULT_MAY_NOT_DO,
    saving: false,
    problem: null,
    onSaveToken: vi.fn(),
    onPairChat: vi.fn(),
    onUnpairChat: vi.fn(),
    onForget: vi.fn(),
    onTestMessage: vi.fn(),
    onClose: vi.fn(),
  };
  return { ...base, ...overrides };
}

describe("TelegramPanel", () => {
  it("shows the three setup steps and an input that is not type='text' in off state", () => {
    const props = createProps({ link: { state: "off" } });
    const { container } = render(<TelegramPanel {...props} />);

    expect(screen.getByText("Open Telegram and message @BotFather")).toBeTruthy();
    expect(screen.getByText("Send /newbot and pick a name")).toBeTruthy();
    expect(screen.getByText("Paste the code it gives you here.")).toBeTruthy();

    const input = container.querySelector('input[name="telegram-token"]');
    expect(input).not.toBeNull();
    expect(input?.getAttribute("type")).not.toBe("text");
    expect(input?.getAttribute("type")).toBe("password");
    expect(input?.getAttribute("autocomplete")).toBe("off");
    expect(input?.getAttribute("spellcheck")).toBe("false");
  });

  it("keeps Save disabled and shows what is wrong when a malformed token is entered", () => {
    const props = createProps({ link: { state: "off" } });
    const { container } = render(<TelegramPanel {...props} />);

    const saveButton = screen.getByRole("button", { name: "Save token" }) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(true);

    const input = container.querySelector('input[name="telegram-token"]') as HTMLInputElement;
    expect(input).not.toBeNull();

    // No colon
    fireEvent.change(input, { target: { value: "123456789" } });
    expect(saveButton.disabled).toBe(true);
    expect(screen.getByText("The token must include a colon between the bot ID and the secret.")).toBeTruthy();

    // Non-numeric prefix
    fireEvent.change(input, { target: { value: "invalid:ABCdefGHIjklMNOpqrSTUvwxYZ_1234567890" } });
    expect(saveButton.disabled).toBe(true);
    expect(screen.getByText("The part before the colon must be numbers only.")).toBeTruthy();

    // Too short secret
    fireEvent.change(input, { target: { value: "123456:short_token" } });
    expect(saveButton.disabled).toBe(true);
    expect(screen.getByText("The secret after the colon is too short (must be at least 30 characters).")).toBeTruthy();

    // Invalid characters in secret
    fireEvent.change(input, { target: { value: "123456:ABCdefGHIjklMNOpqrSTUvwxYZ_1234567890$" } });
    expect(saveButton.disabled).toBe(true);
    expect(
      screen.getByText("The secret after the colon contains invalid characters. Use only letters, numbers, underscores and hyphens.")
    ).toBeTruthy();
  });

  it("calls onSaveToken once and ensures token text is absent from the document after saving", () => {
    const onSaveToken = vi.fn();
    const props = createProps({ link: { state: "off" }, onSaveToken });
    const { container } = render(<TelegramPanel {...props} />);

    const validToken = "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ_1234567890";
    const input = container.querySelector('input[name="telegram-token"]') as HTMLInputElement;
    expect(input).not.toBeNull();

    fireEvent.change(input, { target: { value: validToken } });

    const saveButton = screen.getByRole("button", { name: "Save token" }) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(false);

    fireEvent.click(saveButton);

    expect(onSaveToken).toHaveBeenCalledTimes(1);
    expect(onSaveToken).toHaveBeenCalledWith(validToken);

    expect(container.textContent).not.toContain(validToken);
    expect(container.innerHTML).not.toContain(validToken);
    expect(input.value).toBe("");
  });

  it("offers knock chat ID to onPairChat when linked with null pairedChatId and one knock", () => {
    const onPairChat = vi.fn();
    const now = 1_700_000_120_000;
    const knock: TelegramKnock = {
      chatId: "987654321",
      from: "Amber",
      at: now - 120_000,
    };

    const props = createProps({
      link: {
        state: "linked",
        botName: "WorkBot",
        pairedChatId: null,
        lastHeardAt: now - 240_000,
      },
      knocks: [knock],
      now,
      onPairChat,
    });

    render(<TelegramPanel {...props} />);

    expect(screen.getByText("Someone messaged your bot 2 minutes ago. Is this you?")).toBeTruthy();
    expect(screen.getByText("Amber")).toBeTruthy();
    expect(screen.getByText("Chat ID: 987654321")).toBeTruthy();
    expect(screen.getByText("heard from 4 minutes ago")).toBeTruthy();

    const pairButton = screen.getByRole("button", { name: "Pair this chat" });
    fireEvent.click(pairButton);

    expect(onPairChat).toHaveBeenCalledTimes(1);
    expect(onPairChat).toHaveBeenCalledWith("987654321");
  });

  it("renders every sentence in mayNotDo with equal weight in non-off states", () => {
    const props = createProps({
      link: {
        state: "linked",
        botName: "WorkBot",
        pairedChatId: "987654321",
        lastHeardAt: null,
      },
    });

    render(<TelegramPanel {...props} />);

    for (const sentence of DEFAULT_MAY_NOT_DO) {
      expect(screen.getByText(sentence)).toBeTruthy();
    }
    for (const sentence of DEFAULT_MAY_DO) {
      expect(screen.getByText(sentence)).toBeTruthy();
    }
  });

  it("renders no token input at all in no-keychain state", () => {
    const reason = "System keychain refused encryption key access.";
    const props = createProps({
      link: { state: "no-keychain", reason },
    });

    const { container } = render(<TelegramPanel {...props} />);

    expect(container.querySelector('input[name="telegram-token"]')).toBeNull();
    expect(container.querySelectorAll("input").length).toBe(0);

    expect(
      screen.getByText("This Mac will not give an encryption key, so the token is deliberately not stored at all rather than written in the clear.")
    ).toBeTruthy();
    expect(screen.getByText(reason)).toBeTruthy();
  });

  it("allows unpairing a currently paired chat", () => {
    const onUnpairChat = vi.fn();
    const props = createProps({
      link: {
        state: "linked",
        botName: "WorkBot",
        pairedChatId: "987654321",
        lastHeardAt: null,
      },
      onUnpairChat,
    });

    render(<TelegramPanel {...props} />);

    expect(screen.getByText("987654321")).toBeTruthy();
    expect(screen.getByText("Only this chat is obeyed. Every other is ignored.")).toBeTruthy();
    expect(screen.getByText("never")).toBeTruthy();

    const unpairButton = screen.getByRole("button", { name: "Unpair chat" });
    fireEvent.click(unpairButton);

    expect(onUnpairChat).toHaveBeenCalledTimes(1);
  });

  it("requires inline confirmation before forgetting a bot", () => {
    const onForget = vi.fn();
    const props = createProps({
      link: {
        state: "linked",
        botName: "WorkBot",
        pairedChatId: "987654321",
        lastHeardAt: null,
      },
      onForget,
    });

    render(<TelegramPanel {...props} />);

    const forgetButton = screen.getByRole("button", { name: "Forget bot" });
    fireEvent.click(forgetButton);

    expect(onForget).not.toHaveBeenCalled();
    expect(
      screen.getByText("This removes the stored bot token and disconnects your phone. You will need to paste the token again to reconnect.")
    ).toBeTruthy();

    const confirmButton = screen.getByRole("button", { name: "Yes, forget token" });
    fireEvent.click(confirmButton);

    expect(onForget).toHaveBeenCalledTimes(1);
  });

  it("allows manual chat ID entry when no knocks are present", () => {
    const onPairChat = vi.fn();
    const props = createProps({
      link: {
        state: "linked",
        botName: "WorkBot",
        pairedChatId: null,
        lastHeardAt: null,
      },
      knocks: [],
      onPairChat,
    });

    const { container } = render(<TelegramPanel {...props} />);

    expect(screen.getByText("Message your bot on Telegram and this will fill in automatically.")).toBeTruthy();

    const manualInput = container.querySelector('input[name="telegram-chat-id"]') as HTMLInputElement;
    expect(manualInput).not.toBeNull();

    fireEvent.change(manualInput, { target: { value: "5551234" } });

    const pairButton = screen.getByRole("button", { name: "Pair chat" });
    fireEvent.click(pairButton);

    expect(onPairChat).toHaveBeenCalledTimes(1);
    expect(onPairChat).toHaveBeenCalledWith("5551234");
  });

  it("renders failure reason and allows trying again in failed state", () => {
    const onForget = vi.fn();
    const reason = "Telegram server returned 401 Unauthorized.";
    const props = createProps({
      link: { state: "failed", reason },
      onForget,
    });

    render(<TelegramPanel {...props} />);

    expect(screen.getByText("Connection failed")).toBeTruthy();
    expect(screen.getByText(reason)).toBeTruthy();

    const tryAgainButton = screen.getByRole("button", { name: "Try again" });
    fireEvent.click(tryAgainButton);

    expect(onForget).toHaveBeenCalledTimes(1);
  });

  it("toggles password visibility with the show/hide button", () => {
    const props = createProps({ link: { state: "off" } });
    const { container } = render(<TelegramPanel {...props} />);

    const input = container.querySelector('input[name="telegram-token"]');
    expect(input?.getAttribute("type")).toBe("password");

    const toggleButton = screen.getByRole("button", { name: "Show token" });
    fireEvent.click(toggleButton);

    expect(input?.getAttribute("type")).toBe("text");
    expect(screen.getByRole("button", { name: "Hide token" })).toBeTruthy();

    fireEvent.click(toggleButton);
    expect(input?.getAttribute("type")).toBe("password");
  });

  it("displays an inline alert when a problem prop is present", () => {
    const props = createProps({ problem: "Could not pair chat. Network timed out." });
    render(<TelegramPanel {...props} />);

    const alert = screen.getByRole("alert");
    expect(alert).toBeTruthy();
    expect(screen.getByText("Could not pair chat. Network timed out.")).toBeTruthy();
  });

  it("has exactly one role=status element to announce state changes", () => {
    const props = createProps({ link: { state: "off" } });
    render(<TelegramPanel {...props} />);

    const statusElements = screen.getAllByRole("status");
    expect(statusElements.length).toBe(1);
  });
});

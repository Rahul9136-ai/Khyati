import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { AccountResets } from "@/components/account-resets"
import { ChangePasswordButton } from "@/components/layout/change-password"
import { api, tokenStore } from "@/lib/api"
import { passwordOk } from "@/lib/passwords"
import { useAuth } from "@/store/auth"

import { Login } from "./Login"
import { ResetPassword } from "./ResetPassword"

vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(), post: vi.fn() },
  setSessionExpiredHandler: vi.fn(),
  tokenStore: { access: null, refresh: null, set: vi.fn(), clear: vi.fn() },
}))
const get = vi.mocked(api.get)
const post = vi.mocked(api.post)
const ok = <T,>(data: T) => Promise.resolve({ data: { data } }) as never
const fail = (status: number, message: string) => Promise.reject({ status, message, code: "x" }) as never
const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } })

beforeEach(() => {
  get.mockReset()
  post.mockReset()
  vi.mocked(tokenStore.clear).mockReset()
  useAuth.setState({ user: { id: "u", email: "ava@acme.dev", full_name: "Ava", is_superuser: false, role_names: [], permission_codes: [] } as never, error: null })
})

describe("password rules", () => {
  it("match the server's", () => {
    expect(passwordOk("short1")).toBe(false)
    expect(passwordOk("onlyletters")).toBe(false)
    expect(passwordOk("12345678")).toBe(false)
    expect(passwordOk("ava@acme.dev1", "ava@acme.dev1")).toBe(false)
    expect(passwordOk("Fresh-pass-42", "ava@acme.dev")).toBe(true)
  })
})

describe("Forgot password on the sign-in page", () => {
  it("emails a reset link and says so the same way for any email", async () => {
    post.mockImplementation(() => ok({ detail: "If an account uses that email, we've sent it a link to reset the password.", valid_minutes: 30 }))
    render(<Login />)
    fireEvent.click(screen.getByRole("button", { name: "Forgot password?" }))
    type("Email", "ava@acme.dev")
    fireEvent.click(screen.getByRole("button", { name: /Email me a reset link/ }))
    expect(await screen.findByRole("status")).toHaveTextContent(/we've sent it a link.*expires in 30 minutes/)
    expect(post).toHaveBeenCalledWith("/auth/forgot-password", { email: "ava@acme.dev" })
    fireEvent.click(screen.getByRole("button", { name: /Back to sign in/ }))
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument()
  })

  it("shows the server's reason when it refuses (too many requests)", async () => {
    post.mockImplementation(() => fail(429, "Too many reset requests for this email; try again in 15 minutes"))
    render(<Login />)
    fireEvent.click(screen.getByRole("button", { name: "Forgot password?" }))
    type("Email", "ava@acme.dev")
    fireEvent.click(screen.getByRole("button", { name: /Email me a reset link/ }))
    expect(await screen.findByRole("alert")).toHaveTextContent(/Too many reset requests/)
  })
})

describe("Reset password page (from the link)", () => {
  const open = (search: string) => {
    window.history.pushState({}, "", `/reset-password${search}`)
    return render(<ResetPassword />)
  }

  it("checks the link, then sets the new password once the rules are met", async () => {
    get.mockImplementation(() => ok({ email: "ava@acme.dev" }))
    post.mockImplementation(() => ok({ detail: "Password changed." }))
    open("?token=tok_1234567890")
    expect(await screen.findByText("ava@acme.dev")).toBeInTheDocument()
    expect(get).toHaveBeenCalledWith("/auth/reset-password", { params: { token: "tok_1234567890" } })

    const save = screen.getByRole("button", { name: /Save new password/ })
    type("New password", "weak")
    expect(save).toBeDisabled()
    type("New password", "Fresh-pass-42")
    type("Confirm new password", "Fresh-pass-41")
    expect(within(screen.getByRole("list", { name: "Password rules" })).getByText("Both passwords match").parentElement).toHaveTextContent("(not yet)")
    expect(save).toBeDisabled()
    type("Confirm new password", "Fresh-pass-42")
    expect(save).toBeEnabled()
    fireEvent.click(save)
    expect(await screen.findByRole("status")).toHaveTextContent(/signed out everywhere/)
    expect(post).toHaveBeenCalledWith("/auth/reset-password", { token: "tok_1234567890", new_password: "Fresh-pass-42" })
    expect(tokenStore.clear).toHaveBeenCalled()
  })

  it("says so when the link has expired or was used", async () => {
    get.mockImplementation(() => fail(422, "This reset link has expired or was already used. Ask for a new one."))
    open("?token=old_1234567890")
    expect(await screen.findByRole("alert")).toHaveTextContent(/expired or was already used/)
    expect(screen.getByRole("button", { name: "Back to sign in" })).toBeInTheDocument()
  })

  it("handles a link without a token", async () => {
    open("")
    expect(await screen.findByRole("alert")).toHaveTextContent(/incomplete/)
    expect(get).not.toHaveBeenCalled()
  })
})

describe("Change password (top bar)", () => {
  it("needs the current password; a wrong one is explained", async () => {
    post.mockImplementationOnce(() => fail(401, "Current password is incorrect")).mockImplementationOnce(() => ok({ detail: "Password updated" }))
    render(<ChangePasswordButton />)
    fireEvent.click(screen.getByRole("button", { name: "Change password" }))
    const dialog = screen.getByRole("dialog")
    type("Current password", "nope")
    type("New password", "Next-pass-11")
    type("Confirm new password", "Next-pass-11")
    fireEvent.click(within(dialog).getByRole("button", { name: /Change password/ }))
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Your current password isn't right.")
    type("Current password", "Start@12345")
    fireEvent.click(within(dialog).getByRole("button", { name: /Change password/ }))
    expect(await within(dialog).findByRole("status")).toHaveTextContent("Password changed")
    expect(post).toHaveBeenLastCalledWith("/auth/change-password", { current_password: "Start@12345", new_password: "Next-pass-11" })
  })
})

describe("Settings → Sign-in accounts", () => {
  it("lists accounts and makes a reset link to copy when email isn't set up", async () => {
    get.mockImplementation(() => ok({ items: [
      { id: "1", email: "ava@acme.dev", full_name: "Ava", is_active: true, role_names: ["Employee"], last_login_at: null },
      { id: "2", email: "old@acme.dev", full_name: "Old", is_active: false, role_names: [] },
    ], total: 2 }))
    post.mockImplementation(() => ok({ link: "https://app/reset-password?token=abc", expires_at: "2026-11-09T10:00:00Z", emailed: false, email_problem: "Email isn't set up on the server yet" }))
    render(<QueryClientProvider client={new QueryClient()}><AccountResets /></QueryClientProvider>)
    fireEvent.click(await screen.findByRole("button", { name: "Reset password for ava@acme.dev" }))
    const dialog = screen.getByRole("dialog")
    expect(await within(dialog).findByLabelText("Reset link")).toHaveValue("https://app/reset-password?token=abc")
    expect(within(dialog).getByRole("status")).toHaveTextContent(/Not emailed.*Copy the link/)
    expect(post).toHaveBeenCalledWith("/users/1/reset-password-link")
    expect(screen.getByText("Disabled")).toBeInTheDocument() // disabled accounts can't be reset

    fireEvent.change(screen.getByLabelText("Search accounts"), { target: { value: "ava" } })
    await waitFor(() => expect(get).toHaveBeenLastCalledWith("/users", { params: { size: 50, search: "ava" } }))
  })
})

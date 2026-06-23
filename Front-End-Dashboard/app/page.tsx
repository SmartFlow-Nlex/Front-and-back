"use client";

import Image from 'next/image';
import { useState } from 'react';

export default function Home() {
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(true);

  function goToDashboard() {
    window.location.assign('/dashboard');
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    goToDashboard();
  }

  return (
    <main className="login-shell">
      <section className="login-brand" aria-label="SmartFlow branding">
        <div className="brand-stack">
          <Image
            src="/SMARTFLOW_LOGO.png"
            alt="SmartFlow logo"
            width={700}
            height={500}
            priority
            unoptimized
            className="brand-logo"
          />

          <div className="brand-copy">
            <p>Decision-Intelligence System</p>
          </div>
        </div>
      </section>

      <section className="login-panel" aria-label="Sign in form">
        <div className="login-card">
          <h2>Sign In to Dashboard</h2>

          <form onSubmit={handleSubmit} className="login-form">
            <label className="field-group">
              <span>Username</span>
              <input type="text" name="username" placeholder="Enter your username" />
            </label>

            <label className="field-group">
              <span>Password</span>
              <div className="password-row">
                <input
                  type={showPassword ? 'text' : 'password'}
                  name="password"
                  placeholder="Enter your password"
                />
                <button
                  type="button"
                  className="icon-button"
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  onClick={() => setShowPassword((current) => !current)}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path
                      d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinejoin="round"
                    />
                    <circle cx="12" cy="12" r="2.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
                  </svg>
                </button>
              </div>
            </label>

            <div className="login-options">
              <label className="remember-row">
                <input
                  type="checkbox"
                  checked={rememberMe}
                  onChange={(event) => setRememberMe(event.target.checked)}
                />
                <span>Remember me</span>
              </label>

              <button type="button" className="forgot-link">
                Forgot password?
              </button>
            </div>

            <button type="submit" className="submit-button">
              Sign In
            </button>
          </form>

          <div className="demo-box" aria-label="Demo credentials">
            <p>Demo Credentials:</p>
            <span>Username: operator</span>
            <span>Password: demo123</span>
          </div>
        </div>

        <p className="copyright">{'\u00A9'} 2026 SmartFlow. All rights reserved.</p>
      </section>
    </main>
  );
}


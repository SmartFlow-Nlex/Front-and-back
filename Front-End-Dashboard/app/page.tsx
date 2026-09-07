"use client";

import Image from 'next/image';
import { useState } from 'react';
import { User, Lock, Eye, EyeOff, Activity, TrendingUp, TriangleAlert } from "lucide-react";
import { supabase } from '../lib/supabase';

export default function Home() {
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(true);

  // Sign in form state
  const [signInUsername, setSignInUsername] = useState("");
  const [signInPassword, setSignInPassword] = useState("");

  // Loading and Error States
  const [errorMessage, setErrorMessage] = useState("");
  const [successMessage, setSuccessMessage] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  function goToDashboard() {
    window.location.assign('/dashboard');
  }

  async function handleSignInSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (isLoading) return;
    setErrorMessage("");
    setSuccessMessage("");
    setIsLoading(true);


    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email: signInUsername,
        password: signInPassword,
      });

      if (error) {
        setErrorMessage(error.message);
        setIsLoading(false);
        return;
      }

      goToDashboard();
    } catch (_err: unknown) {
      setErrorMessage("An unexpected error occurred. Please try again.");
      setIsLoading(false);
    }
  }

  return (
    <main className="login-shell">
      {/* Decorative corridor: four lanes sweeping the page with a marching
          dash, the same visual idea as the flow animation on the live map, so
          the first screen looks like the product it opens into. Ornament only,
          so it is hidden from assistive tech and stops under
          prefers-reduced-motion. */}
      <div className="login-flow" aria-hidden="true">
        <svg viewBox="0 0 1440 900" preserveAspectRatio="xMidYMid slice">
          <path className="flow-line l1" d="M-100 250 C 260 140, 520 360, 820 300 S 1300 190, 1560 260" />
          <path className="flow-line l2" d="M-100 430 C 300 330, 560 560, 900 470 S 1320 380, 1560 440" />
          <path className="flow-line l3" d="M-100 620 C 240 540, 600 760, 940 660 S 1340 590, 1560 640" />
          <path className="flow-line l4" d="M-100 800 C 320 720, 640 900, 980 820 S 1360 760, 1560 800" />
        </svg>
      </div>

      <section className="login-brand" aria-label="SmartFlow branding">
        <div className="brand-stack">
          {/* Was pointing at /SMARTFLOW_LOGO.png, which no longer exists in
              public/ and was 404-ing — a broken image on the first screen anyone
              sees. Swapped for the two cuts that do exist, with the same
              three-state theme guard used in the topbar; the login shell takes
              --bg-login, which flips to near-black in dark mode, so a single
              light-background mark would have been wrong half the time. */}
          <Image
            src="/SMARTFLOW_LOGO_WHITE.png"
            alt="SmartFlow NLEX"
            width={512}
            height={512}
            priority
            unoptimized
            className="brand-logo ds-brand-swap is-light"
          />
          <Image
            src="/logo-dark-bg.png"
            alt=""
            width={512}
            height={512}
            priority
            unoptimized
            className="brand-logo ds-brand-swap is-dark"
          />

          <div className="brand-copy">
            {/* The product had no name anywhere on its own first screen — the
                mark is a road glyph with no wordmark, so the only text was a
                grey subtitle. A stylesheet rule for .brand-copy h1 already
                existed with nothing to style; this is the heading it was
                written for. */}
            <h1>SmartFlow <span>NLEX</span></h1>
            <p>Decision-Intelligence System</p>
          </div>

          {/* Fills the dead half of the panel with what the system actually
              does. A login screen is the one page every stakeholder sees
              before they have any context, and three words each is cheaper
              than a paragraph nobody reads. */}
          <ul className="brand-points">
            <li><Activity size={15} aria-hidden="true" /> Live corridor status</li>
            <li><TrendingUp size={15} aria-hidden="true" /> Predictive volume</li>
            <li><TriangleAlert size={15} aria-hidden="true" /> Incident intelligence</li>
          </ul>
        </div>
      </section>

      <section className="login-panel" aria-label="Sign in form">
        <div className="login-card">
              <h2>Sign In to Dashboard</h2>

              <form onSubmit={handleSignInSubmit} className="login-form">
                {errorMessage && <div className="login-alert danger">{errorMessage}</div>}
                {successMessage && <div className="login-alert success">{successMessage}</div>}

                <label className="field-group">
                  <span>Username / Email</span>
                  <div className="input-with-icon">
                    <User className="input-icon-left" size={18} />
                    <input 
                      type="text" 
                      name="username" 
                      placeholder="Enter your username or email" 
                      value={signInUsername}
                      onChange={(e) => setSignInUsername(e.target.value)}
                      required 
                      disabled={isLoading}
                    />
                  </div>
                </label>

                <label className="field-group">
                  <span>Password</span>
                  <div className="input-with-icon">
                    <Lock className="input-icon-left" size={18} />
                    <input
                      type={showPassword ? 'text' : 'password'}
                      name="password"
                      placeholder="Enter your password"
                      value={signInPassword}
                      onChange={(e) => setSignInPassword(e.target.value)}
                      required
                      disabled={isLoading}
                    />
                    <button
                      type="button"
                      className="icon-button-right"
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                      onClick={() => setShowPassword((current) => !current)}
                      disabled={isLoading}
                    >
                      {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                    </button>
                  </div>
                </label>

                <div className="login-options">
                  <label className="remember-row">
                    <input
                      type="checkbox"
                      checked={rememberMe}
                      onChange={(event) => setRememberMe(event.target.checked)}
                      disabled={isLoading}
                    />
                    <span>Remember me</span>
                  </label>

                  <button type="button" className="forgot-link" disabled={isLoading}>
                    Forgot password?
                  </button>
                </div>

                <button type="submit" className="submit-button" disabled={isLoading}>
                  {isLoading ? 'Signing In...' : 'Sign In'}
                </button>
              </form>
        </div>

        <p className="copyright">{'\u00A9'} 2026 SmartFlow NLEX. All rights reserved.</p>
      </section>
    </main>
  );
}


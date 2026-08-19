"use client";

import Image from 'next/image';
import { useState } from 'react';
import { User, Mail, Lock, Eye, EyeOff, ArrowLeft } from "lucide-react";
import { supabase } from '../lib/supabase';

export default function Home() {
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(true);
  const [isSignUp, setIsSignUp] = useState(false);
  const [selectedRole, setSelectedRole] = useState("incident-operator");

  // Sign up form state
  const [signUpName, setSignUpName] = useState("");
  const [signUpEmail, setSignUpEmail] = useState("");
  const [signUpPassword, setSignUpPassword] = useState("");

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

  async function handleSignUpSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (isLoading) return;
    setErrorMessage("");
    setSuccessMessage("");
    setIsLoading(true);

    try {
      const { data, error } = await supabase.auth.signUp({
        email: signUpEmail,
        password: signUpPassword,
        options: {
          data: {
            full_name: signUpName,
            role: selectedRole,
          },
        },
      });

      if (error) {
        setErrorMessage(error.message);
        setIsLoading(false);
        return;
      }

      if (data.user) {
        // Insert user details into public.users table
        const { error: dbError } = await supabase
          .from('users')
          .insert({
            id: data.user.id,
            email: signUpEmail,
            full_name: signUpName,
            role: selectedRole
          });

        if (dbError) {
          console.warn("Failed to write to public.users table:", dbError.message);
        }
      }

      if (data.user && !data.session) {
        setSuccessMessage("Account created! Please check your email to confirm your account.");
        setIsLoading(false);
        setTimeout(() => {
          setIsSignUp(false);
          setSignInUsername(signUpEmail);
          setSuccessMessage("");
        }, 4000);
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
            <p>Decision-Intelligence System</p>
          </div>
        </div>
      </section>

      <section className="login-panel" aria-label={isSignUp ? "Sign up form" : "Sign in form"}>
        <div className="login-card">
          {isSignUp ? (
            <>
              <button 
                type="button" 
                className="back-link" 
                onClick={() => {
                  setIsSignUp(false);
                  setErrorMessage("");
                  setSuccessMessage("");
                }}
                disabled={isLoading}
              >
                <ArrowLeft size={16} /> Back to sign in
              </button>

              <h2>Create your account</h2>
              <p className="login-card-subtitle">Fill in your details and select your role to get started.</p>

              <form onSubmit={handleSignUpSubmit} className="login-form">
                {errorMessage && <div className="login-alert danger">{errorMessage}</div>}
                {successMessage && <div className="login-alert success">{successMessage}</div>}

                <label className="field-group">
                  <span>Full Name</span>
                  <div className="input-with-icon">
                    <User className="input-icon-left" size={18} />
                    <input
                      type="text"
                      name="name"
                      placeholder="Enter your full name"
                      value={signUpName}
                      onChange={(e) => setSignUpName(e.target.value)}
                      required
                      disabled={isLoading}
                    />
                  </div>
                </label>

                <label className="field-group">
                  <span>Email Address</span>
                  <div className="input-with-icon">
                    <Mail className="input-icon-left" size={18} />
                    <input
                      type="email"
                      name="email"
                      placeholder="Enter your email address"
                      value={signUpEmail}
                      onChange={(e) => setSignUpEmail(e.target.value)}
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
                      placeholder="Create a password"
                      value={signUpPassword}
                      onChange={(e) => setSignUpPassword(e.target.value)}
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

                <div className="role-section">
                  <span className="role-section-label">Select your role</span>
                  
                  <div
                    className={`role-card ${selectedRole === 'incident-operator' ? 'active' : ''} ${isLoading ? 'disabled' : ''}`}
                    onClick={() => {
                      if (!isLoading) setSelectedRole('incident-operator');
                    }}
                  >
                    <div className="role-card-content">
                      <div className="role-card-header">
                        <span className="role-card-title">Incident Operator</span>
                        <span className="role-badge operations">Operations</span>
                      </div>
                      <span className="role-card-desc">
                        Monitor and respond to traffic incidents and emergencies on NLEX.
                      </span>
                    </div>
                    <div className="role-card-radio" />
                  </div>

                  <div
                    className={`role-card ${selectedRole === 'data-analyst' ? 'active' : ''} ${isLoading ? 'disabled' : ''}`}
                    onClick={() => {
                      if (!isLoading) setSelectedRole('data-analyst');
                    }}
                  >
                    <div className="role-card-content">
                      <div className="role-card-header">
                        <span className="role-card-title">Data Analyst</span>
                        <span className="role-badge analytics">Analytics</span>
                      </div>
                      <span className="role-card-desc">
                        Analyze traffic patterns and generate predictive forecasting reports.
                      </span>
                    </div>
                    <div className="role-card-radio" />
                  </div>

                  <div
                    className={`role-card ${selectedRole === 'tcc-operator' ? 'active' : ''} ${isLoading ? 'disabled' : ''}`}
                    onClick={() => {
                      if (!isLoading) setSelectedRole('tcc-operator');
                    }}
                  >
                    <div className="role-card-content">
                      <div className="role-card-header">
                        <span className="role-card-title">TCC Operator</span>
                        <span className="role-badge control">Control</span>
                      </div>
                      <span className="role-card-desc">
                        Oversee toll collection and coordinate with traffic control centers.
                      </span>
                    </div>
                    <div className="role-card-radio" />
                  </div>
                </div>

                <button 
                  type="submit" 
                  className="submit-button" 
                  style={{ marginTop: '0.5rem' }} 
                  disabled={isLoading}
                >
                  {isLoading ? 'Creating Account...' : 'Create Account'}
                </button>
              </form>

              <div className="login-footer-link">
                Already have an account? <button 
                  type="button" 
                  onClick={() => {
                    setIsSignUp(false);
                    setErrorMessage("");
                    setSuccessMessage("");
                  }}
                  disabled={isLoading}
                >Sign in</button>
              </div>
            </>
          ) : (
            <>
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

              <div className="login-footer-link">
                Don&apos;t have an account? <button 
                  type="button" 
                  onClick={() => {
                    setIsSignUp(true);
                    setErrorMessage("");
                    setSuccessMessage("");
                  }}
                  disabled={isLoading}
                >Create account</button>
              </div>
            </>
          )}
        </div>

        <p className="copyright">{'\u00A9'} 2026 SmartFlow NLEX. All rights reserved.</p>
      </section>
    </main>
  );
}


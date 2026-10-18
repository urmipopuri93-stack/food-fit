import { ClerkProvider, SignIn, SignUp, useAuth } from '@clerk/react';
import { Link, Navigate, Outlet, Route, Routes, useNavigate } from 'react-router-dom';
import App from './App';
import Landing from './Landing';
import HeatmapPage from './HeatmapPage';
import './auth.css';

const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY?.trim();
const configured = Boolean(publishableKey && /^pk_(test|live)_/.test(publishableKey));

function Loading() {
  return <main className="auth-page"><p className="auth-message" role="status">Loading your session…</p></main>;
}

function Setup() {
  return <main className="auth-page"><section className="auth-message"><h1>Set up Harvest Growth login</h1><p>Add your Clerk publishable key as <code>VITE_CLERK_PUBLISHABLE_KEY</code> in <code>frontend/.env.local</code>, then restart Vite.</p><p>See frontend/README.md for setup instructions.</p><Link to="/">← Back to home</Link></section></main>;
}

function ProtectedRoute() {
  const { isLoaded, isSignedIn } = useAuth();
  if (!isLoaded) return <Loading />;
  return isSignedIn ? <Outlet /> : <Navigate to="/sign-in" replace />;
}

function Home() {
  const { isLoaded, isSignedIn } = useAuth();
  return <Landing loading={!isLoaded} startTo={isSignedIn ? '/dashboard' : '/sign-in'} />;
}

function AuthPage({ signUp = false }: { signUp?: boolean }) {
  const { isLoaded, isSignedIn } = useAuth();
  if (!isLoaded) return <Loading />;
  if (isSignedIn) return <Navigate to="/dashboard" replace />;
  return <main className="auth-page"><section className="auth-content" aria-label={signUp ? 'Create account' : 'Log in'}><Link className="auth-home" to="/">← Back to home</Link><h1>Harvest Growth</h1>{signUp ? <SignUp routing="path" path="/sign-up" signInUrl="/sign-in" /> : <SignIn routing="path" path="/sign-in" signUpUrl="/sign-up" />}</section></main>;
}

export function AuthRouter() {
  const navigate = useNavigate();
  if (!configured) return <Routes><Route path="/" element={<Landing />} /><Route path="*" element={<Setup />} /></Routes>;
  return <ClerkProvider publishableKey={publishableKey!} routerPush={(to) => navigate(to)} routerReplace={(to) => navigate(to, { replace: true })} signInUrl="/sign-in" signUpUrl="/sign-up" signInForceRedirectUrl="/dashboard" signUpForceRedirectUrl="/dashboard" afterSignOutUrl="/" appearance={{ variables: { colorPrimary: '#3e5c34', colorBackground: '#ece7d3', colorForeground: '#2a2b25', fontFamily: '"Chakra Petch", sans-serif', borderRadius: '4px' } }}>
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/sign-in/*" element={<AuthPage />} />
      <Route path="/sign-up/*" element={<AuthPage signUp />} />
      <Route element={<ProtectedRoute />}>
        <Route path="/dashboard" element={<App />} />
        <Route path="/heatmap" element={<HeatmapPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  </ClerkProvider>;
}

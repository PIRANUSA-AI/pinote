import { lazy, Suspense } from 'react'
import { useLocation, Route, Routes, Navigate } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { AuthProvider, useAuth } from './hooks/useAuth'
import { TopChrome } from './components/TopChrome'
import { BottomDock } from './components/BottomDock'
import { InstallBanner } from './components/InstallBanner'
import { ToastProvider } from './components/Toast'
import { ProtectedRoute } from './components/ProtectedRoute'
import { LoadingScreen } from './components/LoadingScreen'
import { ErrorBoundary } from './components/ErrorBoundary'
import { DebugConsole } from './components/DebugConsole'

const Welcome = lazy(() => import('./pages/Welcome'))
const Login = lazy(() => import('./pages/Login'))
const Home = lazy(() => import('./pages/Home'))
const Riwayat = lazy(() => import('./pages/Riwayat'))
const Tugas = lazy(() => import('./pages/Tugas'))
const Profil = lazy(() => import('./pages/Profil'))
const Job = lazy(() => import('./pages/Job'))
const SharedJob = lazy(() => import('./pages/SharedJob'))
const SharedMoM = lazy(() => import('./pages/SharedMoM'))
const MyTasks = lazy(() => import('./pages/MyTasks'))
const Admin = lazy(() => import('./pages/Admin'))
const Playground = lazy(() => import('./pages/Playground'))
const SearchPage = lazy(() => import('./pages/SearchPage'))
const NotFound = lazy(() => import('./pages/NotFound'))
const Extension = lazy(() => import('./pages/Extension'))

function RootPage() {
  const { user, loading } = useAuth()
  if (loading) return <LoadingScreen />
  if (!user) return <Navigate to="/welcome" replace />
  return <Home />
}

function AppShell() {
  const { user, loading } = useAuth()
  // Chrome only for authenticated users; public routes render fullscreen.
  const showChrome = !loading && Boolean(user)
  return (
    <>
      {showChrome && <TopChrome />}
      <AnimatedRoutes />
      {showChrome && <BottomDock />}
    </>
  )
}

function AnimatedRoutes() {
  const location = useLocation()
  return (
    <AnimatePresence mode="sync" initial={false}>
      <motion.div
        key={location.pathname}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.12 }}
        style={{ minHeight: '100%' }}
      >
        <Suspense fallback={<LoadingScreen />}>
          <Routes location={location}>
            <Route path="/" element={<RootPage />} />
            <Route path="/welcome" element={<Welcome />} />
            <Route path="/login" element={<Login />} />
            <Route path="/share/:token" element={<SharedJob />} />
            <Route path="/share/mom/:token" element={<SharedMoM />} />
            <Route path="/tasks/:token" element={<MyTasks />} />
            <Route path="/extension" element={<Extension />} />
            <Route path="/changelog" element={<Extension />} />
            <Route
              path="/riwayat"
              element={
                <ProtectedRoute>
                  <Riwayat />
                </ProtectedRoute>
              }
            />
            <Route
              path="/tugas"
              element={
                <ProtectedRoute>
                  <Tugas />
                </ProtectedRoute>
              }
            />
            <Route
              path="/profil"
              element={
                <ProtectedRoute>
                  <Profil />
                </ProtectedRoute>
              }
            />
            <Route
              path="/job/:id"
              element={
                <ProtectedRoute>
                  <Job />
                </ProtectedRoute>
              }
            />
            <Route
              path="/admin"
              element={
                <ProtectedRoute adminOnly>
                  <Admin />
                </ProtectedRoute>
              }
            />
            <Route
              path="/admin/playground"
              element={
                <ProtectedRoute adminOnly>
                  <Playground />
                </ProtectedRoute>
              }
            />
            <Route
              path="/search"
              element={
                <ProtectedRoute>
                  <SearchPage />
                </ProtectedRoute>
              }
            />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </Suspense>
      </motion.div>
    </AnimatePresence>
  )
}

export default function App() {
  return (
    <AuthProvider>
      <ToastProvider>
        <InstallBanner />
        <DebugConsole />
        <ErrorBoundary>
          <AppShell />
        </ErrorBoundary>
      </ToastProvider>
    </AuthProvider>
  )
}

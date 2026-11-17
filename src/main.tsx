import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router-dom'
import { AppShell } from './components/AppShell'
import { RouteError } from './components/RouteError'
import { ThemeProvider } from './theme/ThemeProvider'
import { ChatPage } from './pages/ChatPage'
import { AppRoute } from './pages/AppRoutes'
import { NotFoundPage } from './pages/NotFoundPage'
import { LoginPage } from './pages/LoginPage'
import { CommunityRoute } from './pages/CommunityRoutes'
import { CreationRoute } from './pages/CreationRoutes'
import { SessionProvider } from './auth/SessionProvider'
import { AccountScope } from './components/AccountScope'
import './styles/tokens.css'
import './styles/app.css'
import './styles/forms.css'
import './styles/plans.css'
import './styles/templates.css'
import './styles/creation.css'

// Memory only. Business mutations must never be replayed automatically.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: true },
    mutations: { retry: false },
  },
})

const router = createBrowserRouter([
  {
    element: <AppShell />,
    errorElement: <RouteError />,
    children: [
      { index: true, element: <Navigate to="/chat" replace /> },
      { path: '/chat', element: <ChatPage /> },
      { path: '/plans', element: <AppRoute screen="plans" /> },
      { path: '/plans/:planId', element: <AppRoute screen="plan" /> },
      { path: '/market', element: <AppRoute screen="market" /> },
      { path: '/market/:templateId', element: <AppRoute screen="template" /> },
      { path: '/create', element: <CreationRoute screen="list" /> },
      { path: '/create/templates/:templateId', element: <CreationRoute screen="template" /> },
      { path: '/create/:draftId', element: <CreationRoute screen="draft" /> },
      { path: '/community', element: <CommunityRoute screen="works" /> },
      { path: '/community/:listingId', element: <CommunityRoute screen="works" /> },
      { path: '/publish/:templateId', element: <CommunityRoute screen="publish" /> },
      { path: '/review', element: <CommunityRoute screen="review" /> },
      { path: '/me', element: <AppRoute screen="account" /> },
      { path: '/login', element: <LoginPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
])

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <SessionProvider><AccountScope><RouterProvider router={router} /></AccountScope></SessionProvider>
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
)

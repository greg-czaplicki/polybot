import { HeadContent, Scripts, createRootRoute } from '@tanstack/react-router'
import { TanStackRouterDevtoolsPanel } from '@tanstack/react-router-devtools'
import { TanStackDevtools } from '@tanstack/react-devtools'

import appCss from '../styles.css?url'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      {
        charSet: 'utf-8',
      },
      {
        name: 'viewport',
        content: 'width=device-width, initial-scale=1',
      },
      {
        title: 'TanStack Start Starter',
      },
    ],
    links: [
      {
        rel: 'stylesheet',
        href: appCss,
      },
      {
        rel: 'manifest',
        href: '/manifest.json',
      },
    ],
  }),

  shellComponent: RootDocument,
})

function RootDocument({ children }: { children: React.ReactNode }) {
  const instanceId = import.meta.env.VITE_PUSHER_BEAMS_INSTANCE_ID || ''
  
  return (
    <html lang="en">
      <head>
        <HeadContent />
        <script src="https://js.pusher.com/beams/2.1.0/push-notifications-cdn.js" />
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function () {
                const instanceId = ${instanceId ? `'${instanceId.replace(/'/g, "\\'")}'` : 'null'};
                if (!instanceId) return;
                if (!('serviceWorker' in navigator)) return;
                
                function initPusherBeams() {
                  if (!window.PusherPushNotifications) {
                    setTimeout(initPusherBeams, 100);
                    return;
                  }
                  
                  if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
                    return;
                  }
                  
                  if ('Notification' in window && Notification.permission === 'denied') {
                    return;
                  }
                  
                  if (!('PushManager' in window)) {
                    return;
                  }
                  
                  navigator.serviceWorker
                    .register('/service-worker.js', { scope: '/' })
                    .then(async (registration) => {
                      let serviceWorker = registration.installing || registration.waiting || registration.active;
                      
                      if (serviceWorker && serviceWorker.state !== 'activated') {
                        await new Promise((resolve) => {
                          const stateChangeHandler = () => {
                            if (serviceWorker.state === 'activated') {
                              serviceWorker.removeEventListener('statechange', stateChangeHandler);
                              resolve(undefined);
                            }
                          };
                          serviceWorker.addEventListener('statechange', stateChangeHandler);
                          setTimeout(() => {
                            serviceWorker.removeEventListener('statechange', stateChangeHandler);
                            resolve(undefined);
                          }, 5000);
                        });
                      }
                      
                      if (!registration.active) {
                        await navigator.serviceWorker.ready;
                      }
                      
                      if ('Notification' in window && Notification.permission === 'default') {
                        try {
                          const permission = await Notification.requestPermission();
                          if (permission === 'denied') return;
                        } catch (err) {
                          return;
                        }
                      }
                      
                      const beamsClient = new window.PusherPushNotifications.Client({
                        instanceId: instanceId,
                      });
                      
                      return beamsClient.start().then(() => {
                        return beamsClient.addDeviceInterest('hello');
                      });
                    })
                    .catch(() => {});
                }
                
                if (document.readyState === 'loading') {
                  document.addEventListener('DOMContentLoaded', initPusherBeams);
                } else {
                  setTimeout(initPusherBeams, 100);
                }
              })();
            `,
          }}
        />
      </head>
      <body>
        {children}
        <TanStackDevtools
          config={{
            position: 'bottom-right',
          }}
          plugins={[
            {
              name: 'Tanstack Router',
              render: <TanStackRouterDevtoolsPanel />,
            },
          ]}
        />
        <Scripts />
      </body>
    </html>
  )
}

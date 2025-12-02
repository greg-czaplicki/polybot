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
        content: 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover',
      },
      {
        name: 'description',
        content: 'Track proxy wallets, monitor positions, and receive alerts for big swings on Polymarket',
      },
      {
        name: 'apple-mobile-web-app-capable',
        content: 'yes',
      },
      {
        name: 'apple-mobile-web-app-status-bar-style',
        content: 'black-translucent',
      },
      {
        name: 'apple-mobile-web-app-title',
        content: 'Polywhaler',
      },
      {
        title: 'Polywhaler - Polymarket Dashboard',
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
      {
        rel: 'apple-touch-icon',
        href: '/logo192.png',
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
                      console.log('[Pusher Beams] Service worker registered');
                      let serviceWorker = registration.installing || registration.waiting || registration.active;
                      
                      if (serviceWorker && serviceWorker.state !== 'activated') {
                        await new Promise((resolve) => {
                          const stateChangeHandler = () => {
                            if (serviceWorker.state === 'activated') {
                              console.log('[Pusher Beams] Service worker activated');
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
                        console.log('[Pusher Beams] Service worker ready');
                      }
                      
                      if ('Notification' in window && Notification.permission === 'default') {
                        try {
                          const permission = await Notification.requestPermission();
                          console.log('[Pusher Beams] Notification permission:', permission);
                          if (permission === 'denied') {
                            console.warn('[Pusher Beams] Notification permission denied');
                            return;
                          }
                        } catch (err) {
                          console.error('[Pusher Beams] Error requesting permission:', err);
                          return;
                        }
                      } else if ('Notification' in window) {
                        console.log('[Pusher Beams] Notification permission:', Notification.permission);
                        if (Notification.permission === 'denied') {
                          console.warn('[Pusher Beams] Notification permission denied');
                          return;
                        }
                      }
                      
                      const beamsClient = new window.PusherPushNotifications.Client({
                        instanceId: instanceId,
                      });
                      
                      return beamsClient.start().then(() => {
                        console.log('[Pusher Beams] Client started');
                        // Subscribe to the wallet-alerts interest to receive push notifications
                        return beamsClient.addDeviceInterest('wallet-alerts').then(() => {
                          console.log('[Pusher Beams] Subscribed to wallet-alerts interest');
                          return beamsClient.getDeviceInterests().then((interestsResponse) => {
                            const interests = Array.isArray(interestsResponse) 
                              ? interestsResponse 
                              : (interestsResponse && interestsResponse.interests ? interestsResponse.interests : []);
                            console.log('[Pusher Beams] Current interests:', interests);
                          });
                        });
                      });
                    })
                    .catch((err) => {
                      console.error('[Pusher Beams] Initialization error:', err);
                    });
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

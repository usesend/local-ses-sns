import { Hono, MiddlewareHandler } from "hono";
import { randomUUID } from "crypto";
import { generateKeyPair } from "crypto";

// Simple in-memory storage
const EMAIL_IDENTITIES = new Map<string, any>();
const CONFIGURATION_SETS = new Map<string, any>();
const SENT_EMAILS = new Array<any>();
const DKIM_KEYS = new Map<string, { privateKey: string; publicKey: string }>();

// Environment variables
const WEBHOOK_URL = process.env.WEBHOOK_URL;

console.log(`WEBHOOK_URL: ${WEBHOOK_URL}`);

// Email patterns and their corresponding events
const EMAIL_EVENT_PATTERNS = {
  "delivered@test.com": ["Send", "Delivery"],
  "bounced@test.com": ["Send", "Bounce"],
  "complained@test.com": ["Send", "Complaint"],
  "rejected@test.com": ["Send", "Reject"],
  "opened@test.com": ["Send", "Delivery", "Open"],
  "clicked@test.com": ["Send", "Delivery", "Click"],
  "delayed@test.com": ["Send", "DeliveryDelay"],
  "failed@test.com": ["Send", "Rendering Failure"],
} as const;

const app = new Hono();

const PORT_ARG = process.argv.find((arg, i) => {
  if (process.argv[i - 1] === "--port" || process.argv[i - 1] === "-p") {
    return process.argv[i];
  }
});

const PORT = parseInt(PORT_ARG || "3000");

console.log(`Starting AWS SES 💌 at http://localhost:${PORT}/api/ses`);
console.log(`Starting AWS SNS 🔔 at http://localhost:${PORT}/api/sns`);

// Middleware to log every request
const requestLogger: MiddlewareHandler = async (c, next) => {
  const { method, url } = c.req;
  console.log(`Received ${method} request for ${url}`);
  await next(); // Pass control to the next handler
};

// Use the middleware globally
app.use("*", requestLogger);

app.get("/", (c) => {
  return c.text("Hello Hono!");
});

/**
 * AWS SES Routes
 */
// GetEmailIdentity - Updated to match external DKIM structure
app.get("/api/ses/v2/email/identities/:identity", async (c) => {
  const { identity } = c.req.param();
  const storedIdentity = EMAIL_IDENTITIES.get(identity);

  if (!storedIdentity) {
    return c.json({
      IdentityType: "DOMAIN",
      FeedbackForwardingStatus: true,
      VerifiedForSendingStatus: true,
      DkimAttributes: {
        SigningEnabled: true,
        Status: "SUCCESS",
        SigningAttributesOrigin: "EXTERNAL",
        DomainSigningSelector: "unsend",
        CurrentSigningKeyLength: "RSA_2048_BIT",
      },
      MailFromAttributes: {
        MailFromDomain: `mail.${identity}`,
        MailFromDomainStatus: "SUCCESS",
        BehaviorOnMxFailure: "USE_DEFAULT_VALUE",
      },
      Policies: {},
      Tags: [],
      VerificationStatus: "SUCCESS",
      VerificationInfo: {
        LastCheckedTimestamp: new Date(),
        LastSuccessTimestamp: new Date(),
      },
    });
  }
  return c.json(storedIdentity);
});

// CreateEmailIdentity
app.post("/api/ses/v2/email/identities", async (c) => {
  const body = await c.req.json();
  const { EmailIdentity, DkimSigningAttributes } = body;

  // Generate or use provided DKIM keys
  let dkimKeys;
  if (DkimSigningAttributes?.DomainSigningPrivateKey) {
    dkimKeys = {
      privateKey: DkimSigningAttributes.DomainSigningPrivateKey,
      publicKey: "mock-public-key", // In real implementation, derive from private key
    };
  } else {
    // Mock key generation for testing
    dkimKeys = {
      privateKey: "mock-private-key",
      publicKey: "mock-public-key",
    };
  }

  const identity = {
    IdentityType: "DOMAIN",
    FeedbackForwardingStatus: true,
    VerifiedForSendingStatus: true,
    DkimAttributes: {
      SigningEnabled: true,
      Status: "SUCCESS",
      SigningAttributesOrigin: "EXTERNAL",
      DomainSigningSelector:
        DkimSigningAttributes?.DomainSigningSelector || "unsend",
      DomainSigningPrivateKey: dkimKeys.privateKey,
      CurrentSigningKeyLength: "RSA_2048_BIT",
    },
    MailFromAttributes: {
      MailFromDomain: `mail@${EmailIdentity}`,
      MailFromDomainStatus: "SUCCESS",
      BehaviorOnMxFailure: "USE_DEFAULT_VALUE",
    },
    Policies: {},
    Tags: [],
    VerificationStatus: "SUCCESS",
    VerificationInfo: {
      LastCheckedTimestamp: new Date(),
      LastSuccessTimestamp: new Date(),
    },
  };

  EMAIL_IDENTITIES.set(EmailIdentity, identity);
  DKIM_KEYS.set(EmailIdentity, dkimKeys);

  return c.json({
    DkimAttributes: identity.DkimAttributes,
    VerificationStatus: identity.VerificationStatus,
    VerificationInfo: identity.VerificationInfo,
  });
});

// DeleteEmailIdentity
app.delete("/api/ses/v2/email/identities/:identity", async (c) => {
  const { identity } = c.req.param();
  EMAIL_IDENTITIES.delete(identity);
  return c.json({});
});

// PutEmailIdentityMailFromAttributes
app.put("/api/ses/v2/email/identities/:identity/mail-from", async (c) => {
  const { identity } = c.req.param();
  const body = await c.req.json();
  const { MailFromDomain } = body;

  const storedIdentity = EMAIL_IDENTITIES.get(identity);
  if (!storedIdentity) {
    return c.json({ error: "Identity not found" }, 404);
  }

  storedIdentity.MailFromAttributes = {
    MailFromDomain,
    MailFromDomainStatus: "SUCCESS",
    BehaviorOnMxFailure: "USE_DEFAULT_VALUE",
  };

  EMAIL_IDENTITIES.set(identity, storedIdentity);
  return c.json({
    $metadata: {
      httpStatusCode: 200,
    },
  });
});

// Helper function to send webhook notifications
async function sendWebhookNotification(
  messageId: string,
  eventType: string,
  recipient: string
) {
  if (!WEBHOOK_URL) {
    console.log("No webhook URL configured, skipping notification");
    return;
  }

  const timestamp = new Date().toISOString();
  const topicArn = "arn:aws:sns:us-east-1:000000000000:ses-notifications";

  let eventData: any = {
    eventType,
    mail: {
      timestamp,
      messageId,
      source: "sender@test.com",
      destination: [recipient],
    },
  };

  // Add event-specific data
  switch (eventType) {
    case "Send":
      eventData.send = {};
      break;
    case "Delivery":
      eventData.delivery = {
        timestamp,
        processingTimeMillis: 100,
        recipients: [recipient],
        smtpResponse: "250 OK",
      };
      break;
    case "Bounce":
      eventData.bounce = {
        bounceType: "Permanent",
        bounceSubType: "General",
        timestamp,
        feedbackId: randomUUID(),
        bouncedRecipients: [{ emailAddress: recipient }],
      };
      break;
    case "Complaint":
      eventData.complaint = {
        complainedRecipients: [{ emailAddress: recipient }],
        timestamp,
        feedbackId: randomUUID(),
      };
      break;
    case "Open":
      eventData.open = {
        ipAddress: "127.0.0.1",
        timestamp,
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
      };
      break;
    case "Click":
      eventData.click = {
        ipAddress: "127.0.0.1",
        timestamp,
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
        link: "https://unsend.dev",
        linkTags: {
          campaign: "welcome",
          type: "cta",
        },
      };
      break;
    case "DeliveryDelay":
      eventData.deliveryDelay = {
        delayType: "MailboxFull",
        expirationTime: new Date(
          Date.now() + 24 * 60 * 60 * 1000
        ).toISOString(), // 24 hours from now
        delayedRecipients: [recipient],
        timestamp,
      };
      break;
    // Add other event types as needed
  }

  const payload = {
    Type: "Notification",
    MessageId: randomUUID(),
    TopicArn: topicArn,
    Message: JSON.stringify(eventData),
    Timestamp: timestamp,
    SignatureVersion: "1",
    Signature: "mock-signature",
    SigningCertURL:
      "https://sns.us-east-1.amazonaws.com/SimpleNotificationService.pem",
  };

  try {
    const response = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      console.error(
        `Failed to send webhook notification: ${response.statusText}`
      );
    } else {
      console.log(`Sent ${eventType} notification for ${recipient}`);
    }
  } catch (error) {
    console.error("Error sending webhook notification:", error);
  }
}

// Modified SendEmail endpoint
app.post("/api/ses/v2/email/outbound-emails", async (c) => {
  const body = await c.req.json();
  const messageId = randomUUID();
  SENT_EMAILS.push({ ...body, MessageId: messageId });

  // Extract recipient email
  const destination = body.Destination;
  const toAddresses = destination?.ToAddresses || [];

  // Process each recipient
  for (const recipient of toAddresses) {
    let matchFound = false;
    // Check if this recipient should trigger specific events
    for (const [pattern, events] of Object.entries(EMAIL_EVENT_PATTERNS)) {
      if (recipient.toLowerCase() === pattern.toLowerCase()) {
        matchFound = true;
        // Send events with small delays to simulate real-world behavior
        events.forEach((eventType, index) => {
          setTimeout(() => {
            sendWebhookNotification(messageId, eventType, recipient);
          }, index * 1000); // 1 second delay between each event
        });
        break;
      }
    }

    // If no pattern matched, send default Send and Delivery events
    if (!matchFound) {
      setTimeout(() => {
        sendWebhookNotification(messageId, "Send", recipient);
      }, 0);
      setTimeout(() => {
        sendWebhookNotification(messageId, "Delivery", recipient);
      }, 1000);
    }
  }

  return c.json({ MessageId: messageId });
});

// GetAccount
app.get("/api/ses/v2/account", async (c) => {
  return c.json({
    ProductionAccessEnabled: true,
    SendQuota: {
      Max24HourSend: 50000,
      MaxSendRate: 10,
      SentLast24Hours: SENT_EMAILS.length,
    },
    SendingEnabled: true,
  });
});

// CreateConfigurationSetEventDestination
app.post(
  "/api/ses/v2/configuration-sets/:configSet/event-destinations",
  async (c) => {
    const { configSet } = c.req.param();
    const body = await c.req.json();

    const destinations = CONFIGURATION_SETS.get(configSet) || [];
    destinations.push(body);
    CONFIGURATION_SETS.set(configSet, destinations);

    return c.json({});
  }
);

app.post("/sns", async (c) => {
  const body = c.req.json();
  console.log(body);
  return c.text("Hello Hono!");
});

// GetAllEmails
app.get("/api/emails", async (c) => {
  return c.json({
    emails: SENT_EMAILS,
    $metadata: {
      httpStatusCode: 200,
    },
  });
});

export default {
  port: PORT,
  fetch: app.fetch,
};

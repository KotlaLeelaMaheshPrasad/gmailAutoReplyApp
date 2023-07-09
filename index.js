/**
 * file system module allows us to work with the file system on our computer
 */
const fs = require('fs').promises;

/**
 * Path module provides a way to work with directories and file paths
 */
const path = require('path');

/**
 * Process module provides interaction with the current node.js process
 */
const process = require('process');

/**
 * The @google-cloud/local-auth library is a client library provided by Google Cloud to simplify the authentication process
 * for local applications using Google Cloud services. It is specifically designed to facilitate the local authentication flow,
 * which is typically used when developing applications that run on a user's local machine.
 * 
 * The library provides an authenticate method that helps you authenticate your application using OAuth 2.0
 * and retrieve the necessary credentials to make authorized API calls to Google Cloud services. 
 * 
 */
const {authenticate} = require('@google-cloud/local-auth');

/**
 * The googleapis client library is a powerful and comprehensive JavaScript library provided by Google
 * to interact with various Google APIs, including Google Cloud APIs, Google Drive API, Gmail API, and many others.
 * It provides a unified and easy-to-use interface for making API requests, handling authentication, and managing resources.
 * 
 * When you use the googleapis library, you have access to the google object,
 * which serves as the main entry point for interacting with Google APIs. 
 * The google object provides a set of namespaces and methods that allow you to work with specific Google services 
 * and perform operations such as listing resources, creating new resources, updating existing resources, and more.
 * 
 */
const {google} = require('googleapis');

// If modifying these scopes, delete token.json.
const SCOPES = ['https://www.googleapis.com/auth/gmail.modify'];
// The file token.json stores the user's access and refresh tokens, 
// and is created automatically when the authorization flow completes for the first time.
const TOKEN_PATH = path.join(process.cwd(), 'token.json');
const CREDENTIALS_PATH = path.join(process.cwd(), 'credentials.json');

let emailAddress = null;

//Reads previously authorized credentials from the saved file
async function loadSavedCredentialsIfExist() {
  try {
    const content = await fs.readFile(TOKEN_PATH);
    const credentials = JSON.parse(content);
    return google.auth.fromJSON(credentials);
  } catch (err) {
    return null;
  }
}

//save credentials into token.json.
async function saveCredentials(client) {
  const content = await fs.readFile(CREDENTIALS_PATH);
  const keys = JSON.parse(content);
  const key = keys.installed || keys.web;
  const payload = JSON.stringify({
    type: 'authorized_user',
    client_id: key.client_id,
    client_secret: key.client_secret,
    refresh_token: client.credentials.refresh_token,
  });
  await fs.writeFile(TOKEN_PATH, payload);
}


//Load or request or authorization to call APIs.
async function authorize() {
  let client = await loadSavedCredentialsIfExist();
  if (client) {
    return client;
  }

  //starts local authentication,  does login with google and returns credentials required
  client = await authenticate({
    scopes: SCOPES,
    keyfilePath: CREDENTIALS_PATH,
  });
  if (client.credentials) {
    await saveCredentials(client);
  }
  return client;
}

//returns the label id (creates the label if not present)
async function getLabelId(auth, labelName) {
  const gmail = google.gmail({ version: 'v1', auth });

  const labels = await gmail.users.labels.list({
    userId: 'me',
  });

  const label = labels.data.labels.find((l) => l.name === labelName);
  if (label) {
    return label.id;
  } else {
    // If the label doesn't exist, create it and return its ID
    const newLabel = await gmail.users.labels.create({
      userId: 'me',
      resource: {
        name: labelName,
      },
    });

    return newLabel.data.id;
  }
}

//applies label (autoreply) to the thread
async function applyLabel(auth, threadId){
    const gmail = google.gmail({ version: 'v1', auth });
    const labelId = await getLabelId(auth, "autoreply");
    await gmail.users.threads.modify({
      userId: 'me',
      id: threadId,
      resource: {
        addLabelIds: [labelId],
      }
    });
}

//sends reply to thread 
async function sendReply(auth, threadId, replymessage) {
  const gmail = google.gmail({ version: 'v1', auth });

  const utf8Subject = `=?utf-8?B?${Buffer.from(replymessage.subject).toString('base64')}?=`;

  const raw = Buffer.from(`From: me\r\nTo: ${replymessage.to}\r\nSubject: ${utf8Subject}\r\nIn-Reply-To: ${replymessage.inReplyTo}\r\n\r\n${replymessage.message}`).toString('base64');
  await gmail.users.messages.send({
    userId: 'me',
    id: threadId,
    resource: {
      raw,
      threadId,
    },
  });
}

//sends mail to a thread if it is previously not replied by the user
async function sendMailToThreadIfUnreplied(auth, threadId){
    try{
        const gmail = google.gmail({ version: 'v1', auth });
        let res = await gmail.users.threads.get({
                    userId: 'me',
                    id: threadId,
            });
        const thread = res.data;
        const messages = thread.messages;
        const emailHeaders = messages[0].payload.headers;
        let emailSubject, emailFrom, emailMessageId;
        
        //checks whether thread has been previously replied
        let hasReplied = messages.some((message) =>{
          const fromValue =  message.payload.headers.find(header => header.name === 'From').value;
          return fromValue.includes(emailAddress);
        });
        if (hasReplied) {
          console.log('Skipping thread that has been previously replied to:', threadId);
          return;
        }

        emailHeaders.forEach(eachHeader => {
            console.log(eachHeader.name);
            if(eachHeader.name === "From"){
                emailFrom = eachHeader.value;
            }
            if(eachHeader.name === "Subject"){
                emailSubject = eachHeader.value;
            }
            if(eachHeader.name === "Message-ID"){
                emailMessageId = eachHeader.value;
            }
            
        })
        

        //reply message data
        const replyMessage = {
            to: emailFrom,
            subject: `Re: ${emailSubject}`,
            inReplyTo: emailMessageId,
            message: 'Boss is busy, will get back to you soon',
          };
        
        await sendReply(auth, threadId, replyMessage);
        await applyLabel(auth, threadId);
    }catch(err){
        console.log(err);
    }
}

//processes unreplied threads in the inbox
async function processUnrepliedThreads(auth) {
    const gmail = google.gmail({version: 'v1', auth});

    let unrepliedThreads = await gmail.users.threads.list({
        userId: 'me',
        q: 'is:unread',
    })
    const threads = unrepliedThreads.data.threads;
    if(threads){
      if(threads.length==0){
              return;
      }
      for(const eachthread of threads){
          await sendMailToThreadIfUnreplied(auth, eachthread.id);
      }
    }
}

//Retruns the authenticated email address -- users email address
async function getAuthenticatedEmailAddress(auth) {
  const gmail = google.gmail({ version: 'v1', auth });

  const userInfo = await gmail.users.getProfile({
    userId: 'me',
  });
  return userInfo.data.emailAddress;
}

async function doProcess(auth){
    if(emailAddress===null)
    emailAddress = await getAuthenticatedEmailAddress(auth);
    await processUnrepliedThreads(auth);
}


const autoReplyApp = () => {
  authorize().then(doProcess).catch(console.error);
};

setInterval(autoReplyApp, getRandomInterval(45000, 120000));

//gets random value between 45sec and 120sec
function getRandomInterval(min, max) {
  return Math.floor(Math.random() * (max - min + 1) + min);
}

/**
 * Updates that can be done
 * authentication can be done by us
 * we can start a server and pass a redirect uri such that after login in with google, a code will be generated
 * After login in with google, consent screen redirects to redirect uri along with code, and 
 * This code can be used to get the access token and refresh token.
 * Our server can lsiten to get request of redirect uri and obtain code.
 */
'use strict';
const snoowrap = require('snoowrap');
const Twit = require('twit');
const imgur = require('imgur');

const debug = true;

const blacklist = ['canarybot', 'TweetsInCommentsBot', 'TweetPoster'];

function body(name, url, text, images) { 
  var ret =
`[**${name}**](${url})

>${text}

`
  if (images) ret +=
`>[[Imgur rehost]](${images})

`;
  ret += 
`----

`;
  return ret;
}
function footer() {
  return `Beep boop I am a bot`;
}


// Set up accounts

// Reddit interaction
const snoo = new snoowrap({
  user_agent:     process.env.USER_AGENT,
  client_id:      process.env.SNOO_ID,
  client_secret:  process.env.SNOO_SECRET,
  refresh_token:  process.env.SNOO_REFRESH,
});

// Twitter interaction
const twit = new Twit({
  consumer_key:         process.env.TWIT_ID,
  consumer_secret:      process.env.TWIT_SECRET,
  access_token:         process.env.TWIT_AT,
  access_token_secret:  process.env.TWIT_ATS,
  timeout_ms:           60*1000,
});

// Imgur interaction
imgur.setClientId(process.env.IMGUR_ID);

if(debug) console.log('Initialized accounts');


// Create treated comment registry
var cache = {};
// TODO: delete all cached entries older than x minutes (hours?)

console.time('Treat new comments');
// TODO: wrap this in setInterval
// Fetch all new comments in subreddit
var s = snoo.get_new_comments('test')
  // Extract twitter links
  .map(comment => {
    //if(debug) console.log('Parsing '+comment.id);
    comment.twitter_urls = comment.body.match(/https:\/\/twitter\.com\/(\w+)\/status*\/(\d+)/g);
    return comment;
  })
  // Filter out comments without twitter links, those we already treated and the blacklist
  .filter(comment => {
    if (comment.twitter_urls 
          && !cache[comment.id] 
          && blacklist.indexOf(comment.author.name) != -1) {
      if(debug) console.log('Adding comment '+comment.id+' to cache');
      cache[comment.id] = new Date();
      return true;
    } else {
      return false;
    }
  })
  // Fetch tweet info
  .map(comment => {
    if(debug) console.log(comment.twitter_urls);
    // Extract status ids from URLs 
    let tweets = comment.twitter_urls.map(url => {return url.substring(url.lastIndexOf('/')+1);});
    // Add promise for tweets to comment
    return  (
              tweets.length>1
              ? twit.get('statuses/lookup', {id: tweets.join(',')}).then(tweet=>tweet.data)
              : twit.get('statuses/show/:id', {id: tweets[0]}).then(tweet=>[tweet.data])
            )
            .then(tweets=>{
              comment.tweets = tweets;
              return comment;
            });
  })
  // Extract image url's, users and text from tweets
  .map(comment => {
    comment.tweets = comment.tweets.map(tweet => {
      var ret = {
        user : tweet.user.screen_name,
        user_url : 'https://twitter.com/'+tweet.user.screen_name,
        text : tweet.text
      };
      // Extract image urls; for videos/gifs, take thumbnail
      var pictures = tweet.entities.media;
      if (pictures) ret.pictures =  pictures
                                      .filter(media => media.type=='photo')
                                      .map(photo => photo.media_url_https+':large');
      // Replace all user mentions with links
      var users = tweet.entities.user_mentions;
      users.forEach(user => ret.text = ret.text.replace(new RegExp('@'+user.screen_name, 'g'), '[@'+user.screen_name+'](https://twitter.com/'+user.screen_name+')'));
      // Replace all hashtags
      var hashtags = tweet.entities.hashtags;
      hashtags.forEach(hashtag => ret.text = ret.text.replace(new RegExp('#'+hashtag, 'g'), '[#'+hashtag+'](https://twitter.com/search?q=%23'+hashtag+')'));
      // Replace all links with fully resolved ones
      var urls = tweet.entities.urls;
      urls.forEach(url => ret.text = ret.text.replace(new RegExp(url.url, 'g'), '['+url.display_url+']('+url.expanded_url+')'));
      return ret;
    });
    if(debug) console.log(comment.tweets);
    return comment;
  })
  // Rehost images on imgur
  .map(comment => {
    return Promise.all(
      // Map tweets on promises of tweets
      comment.tweets.map(tweet=>{
        if (!tweet.pictures) return tweet;
        // Create album, returns promise of tweet
        return imgur.createAlbum()
          // Save URL and hash
          .then(json=>{tweet.album = 'http://imgur.com/a/'+json.data.id; return json.data.deletehash;})
          // Upload images
          .then(hash => imgur.uploadImages(tweet.pictures, 'Url', hash))
          // Return tweet
          .then(album => tweet);
      })
    )
    .then(tweets=>{
      if(debug) console.log('Rehosted images');
      comment.tweets = tweets;
      return comment;
    });
  })
  // Post reply to reddit
  .each(comment=> {
    let reply = comment.tweets.map(tweet=>{
      return body(tweet.user, 
                  tweet.user_url,
                  tweet.text,
                  tweet.album);
    }).join('') + footer();
    if(debug) console.log(reply);
    comment.reply(reply);
  })
  .then(comments=>{console.timeEnd('Treat new comments');});
  

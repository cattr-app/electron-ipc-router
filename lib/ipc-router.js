const uuid = require('uuid/v4');

/**
 * Environment in which this file currently executes (renderer or main)
 * @type {String}
 */
const executionEnvironment = (process.type === 'renderer') ? 'renderer' : 'main';

/**
 * Simple request-response router for Electron IPC
 */
class IPCRouter {

  /**
   * Creates IPC router
   * @param {Object<EventEmitter>}  ipc   IPC instance
   * @param {String}                id    Identifier of the channel for this router
   */
  constructor(ipc, id = 'main') {

    // Check is correct IPC interface given
    if (typeof ipc !== 'object') throw new Error('Incorrect IPC interface given');

    // Check role correctness
    this._role = executionEnvironment;
    this._oppositeRole = (this._role === 'main') ? 'renderer' : 'main';

    // Pool for enpoint handlers (key = route, value = route handling Promise)
    this._routeHandlers = {};

    // Pool for requests (key = packet UUID, value = )
    this._requestsPool = {};

    // Pool for interceptors (key = code UUID, value = handler)
    this._interceptorsPool = {};

    // Slot for WebContents instance
    this._webcontents = null;

    // Saves IPC interface internally
    this._ipc = ipc;

    // Router identificator
    this._routerId = id;

    // Held (unsent) packets queue
    this._heldPacketsQueue = [];

    // Set up requests listener
    ipc.on(`ipc-req:${this._role}:${this._routerId}`, async (event, packet) => {

      // Ignoring packets with incorrect header
      if (typeof packet._header !== 'object' || typeof packet._header.endpoint !== 'string' || typeof packet._header.id !== 'string') return;

      // Checking is this route serviceable (i.e. has a registered handler)
      if (typeof this._routeHandlers[packet._header.endpoint] === 'undefined') {

        // Respond with error packet
        event.sender.send(`ipc-res:${this._oppositeRole}:${this._routerId}`, { _header: { id: packet._header.id, code: 404 }, body: {} });
        return;

      }

      // Building request object
      const request = { packet };

      /**
       * Responds to the request
       * @param  {Number}  [code=200]  Request status code (default is 200 OK)
       * @param  {Object}  body        Response data
       * @return {Boolean}             True, if response is sent
       */
      request.send = (...args) => {

        // Checking is args defined
        if (args.length === 0) throw new Error('Incorrect call of request.send function');

        // Argument parsing magic here
        const code = (args.length > 1) ? args[0] : 200; // Default code is 200
        const body = (args.length > 1) ? args[1] : args[0];

        // Checking arguments format
        if (typeof code !== 'number' || typeof body !== 'object') throw new TypeError('Incorrect arguments types in request.send function');

        // Responding
        event.sender.send(`ipc-res:${this._oppositeRole}:${this._routerId}`, {

          // Set header data
          _header: { id: packet._header.id, code },

          // Attach respnse body
          body

        });

        // That's all
        return true;

      };

      // Call endpoint handler with request object
      await this._routeHandlers[packet._header.endpoint](request);

    });

    // Set up responses listener
    ipc.on(`ipc-res:${this._role}:${this._routerId}`, async (event, packet) => {

      // Ignoring packets with incorrect header
      if (typeof packet._header !== 'object' || typeof packet._header.id !== 'string' || typeof packet._header.code !== 'number')

        throw new TypeError(
          'Packet template:\n' +
          '\theader: Object;\n' +
          '\theader.id: String;\n' +
          '\theader.code: Number\n' +
          'But current one appear:\n' +
          `\theader: ${typeof packet._header};\n` +
          `\theader.id: ${typeof packet._header.id};\n` +
          `\theader.code: ${typeof packet._header.code}\n` +
          'Therefore packet is ignored'
        );


      // Ignoring packets which isn't registered in our requests pool
      if (typeof this._requestsPool[packet._header.id] === 'undefined')
        return false;

      // Building response object
      const response = { _id: packet._header.id, code: packet._header.code, body: packet.body };

      // Getting codes, that should be handled
      const interceptorsKeys = Object.keys(this._interceptorsPool);

      // If the code of this response have to be handled
      if (interceptorsKeys.includes(response.code.toString())) {

        // Fire the handler
        this._interceptorsPool[response.code].handler();

        // If passthru is forbidden
        if (!this._interceptorsPool[response.code].passthru)

          // Throw error
          this._requestsPool[packet._header.id].errorHandler(new Error('Passthru is restricted by the interceptor!'));


      }

      // Calling request handler
      this._requestsPool[packet._header.id].handler(response);

      // Destroy entity in requests pool
      delete this._requestsPool[packet._header.id];

    });

    /**
     * Fires event from main to renderer process using WebContents
     * @param   {String}  event    Event name
     * @param   {Object}  message  Event payload
     * @returns {Boolean}          True, if event successfully emitted
     */
    this._sendWebContentsEvent = (event, message) => {

      // Checking event and message types
      if (typeof event !== 'string' || typeof message === 'undefined') throw new TypeError('Incorrect event name or payload');

      // Checking is WebContents instance already set in this IPC instance
      if (this._webcontent) throw new Error('WebContents instance is not linked into this IPC instance');

      // Store packets in queue if renderer is not available at the moment
      if (!this._webcontents) {

        this._heldPacketsQueue.push({ event, message });
        return false;

      }

      // Fires an event
      this._webcontents.send(event, message);
      return true;

    };

    /**
     * Creates destructor triggered by packet timeout
     * @param  {String}          packetId  Packet identifier
     * @param  {Number}          timeout   Response timeout (in milliseconds)
     * @return {Object<Timeout>}           Created timeout
     */
    this._createTimeoutDestructor = (packetId, timeout) => {

      // Returning Timeout object
      return setTimeout(() => {

        // Checking is this request exists
        if (typeof this._requestsPool[packetId] === 'undefined') return;

        // Returning error in response handler
        this._requestsPool[packetId].handler({ _id: packetId, code: -1, body: {} });

        // Destroying request in pool
        delete this._requestsPool[packetId];

      }, timeout);

    };

  }

  /**
 * Sets interceptor
 * @param {Number}                  code      Status code to intercept
 * @param {Boolean}                 passthru  Should we pass response to origin request function
 * @param {Function|AsyncFunction}  handler   Interceptor handling routine
 */
  setInterceptor(code, passthru, handler) {

    // Get the interceptors
    const interceptorsKeys = Object.keys(this._interceptorsPool);

    // If this code is not registred to be intercepted
    if (code in interceptorsKeys)

    // No multiple interceptors
      throw new TypeError('Interceptor for this status code has been already set! No multiple interceptors!');

    else

    // Add the intercepor
      this._interceptorsPool[code] = {

        handler,
        passthru

      };


  }

  /**
   * Sets WebContent instance
   * @param   {Object}  wc  WebContents
   * @returns {Boolean}     True, if WebContents successfully linked
   */
  setWebContents(wc) {

    // Skipping execution if this function called in renderer process
    if (executionEnvironment === 'renderer') return false;

    // Checking argument type
    if (typeof wc !== 'object') throw new TypeError('Incorrect WebContent instance passed');

    // Setting WebContent
    this._webcontents = wc;

    // Emit all unsent messages
    if (this._heldPacketsQueue.length > 0)
      while (this._heldPacketsQueue.length > 0) {

        const packet = this._heldPacketsQueue.shift();
        wc.send(packet.event, packet.message);

      }

    return true;

  }

  /**
   * Add enpoint listener
   * @param  {String}         endpoint             IPC endpoint
   * @param  {AsyncFunction}  handler              Request handler
   * @param  {Boolean}        [override = false]   Allow to override existring handler
   * @return {Boolean}                             True, if handler successfully registered
   */
  serve(endpoint, handler, override = false) {

    // Checking input arguments
    if (typeof endpoint !== 'string' || typeof handler !== 'function') throw new TypeError('Trying to register incorrect endpoint or handler');

    // Checking is this endpoint already have a handler?
    if (!override && typeof this._routeHandlers[endpoint] !== 'undefined') throw new Error(`Restricted attempt to override handler for endpoint: ${endpoint}`);

    // Apply handler
    this._routeHandlers[endpoint] = handler;
    return true;

  }

  /**
   * Makes request and do not wait for the response
   * @param  {String}   endpoint  IPC endpoint
   * @param  {Object}   body      Data
   * @return {Boolean}            True, if event successfully emitted
   */
  emit(endpoint, body) {

    // Checking input data
    if (typeof endpoint !== 'string' || typeof body !== 'object') throw new TypeError('Trying to emit incorrect endpoint or body');

    // Choosing appropriate sending function based on current execution environment (main-to-renderer must use WebContents)
    if (executionEnvironment === 'main') this._sendWebContentsEvent(`ipc-req:${this._oppositeRole}:${this._routerId}`, { _header: { id: uuid(), endpoint }, body });
    else this._ipc.send(`ipc-req:${this._oppositeRole}:${this._routerId}`, { _header: { id: uuid(), endpoint }, body });

    return true;

  }

  /**
   * Makes request
   * @param  {String}          endpoint         IPC endpoint
   * @param  {Object}          body             Request body
   * @param  {Number}          [timeout=30000]  Timeout (to disable timeout, set this value to 0)
   * @return {Promise<Object>}                  Response
   */
  async request(endpoint, body, timeout = 30000) {

    // Returning promise
    return new Promise((resolve, reject) => {

      // Checking input data
      if (typeof endpoint !== 'string' || typeof body !== 'object')
        return reject(new TypeError('Trying to request incorrect endpoint or body'));

      // Checking timeout validity
      if (typeof timeout !== 'number' || timeout < 0)
        return reject(new TypeError(`Incorrect packet timeout: ${timeout}`));

      // Create request object
      const request = { _header: { endpoint, id: uuid() }, body };

      // Creating timeout destructor if timeout is enabled (timeout > 0)
      const timer = (timeout > 0) ? this._createTimeoutDestructor(request._header.id, timeout) : null;

      // Registering request
      this._requestsPool[request._header.id] = {

        // Saving Timeout instance
        timer,

        // Response handler
        handler: response => {

          // Destruct timeout timer
          clearTimeout(timer);

          // Resolve promise
          return resolve(response);

        },

        // Reject promise
        errorHandler: error => {

          return reject(error);

        }

      };

      // Making request
      // Electron "main" process can't fire an event to "renderer" via IPC. We should use WebContents events for that
      if (executionEnvironment === 'renderer') this._ipc.send(`ipc-req:${this._oppositeRole}:${this._routerId}`, request);
      else this._sendWebContentsEvent(`ipc-req:${this._oppositeRole}:${this._routerId}`, request);

    });

  }

}

module.exports = IPCRouter;

# Amazing Electron IPC Router
Простой роутер, реализующий request-response паттерн при работе с Electron IPC.

## Установка и зависимости
Так как он пока ещё не выложен в репозитории пакетного менеджера, то установка происходит через указание репозитория в Git. Идём в `package.json`, и в секцию `dependencies` прописываем следующее
```javascript
// Если работа с гитом осуществляется через SSH
"amazing-electron-ipc-router": "git+ssh://git@git.amazingcat.net:AmazingTime/amazing-electron-ipc-router.git"

// .. или, если работаем через HTTPS
"amazing-electron-ipc-router": "git+https://git@git.amazingcat.net/AmazingTime/amazing-electron-ipc-router.git"
```

После этого делаем `npm install` и всё хорошо.
Данный модуль содержит у себя в зависимостях пакет [uuid](https://www.npmjs.com/package/uuid).

## Простые примеры
Простой пример работы с IPC-роутером для общего понимания.

**Main-процесс**
```javascript
// Получаем стандартный IPC в Electron
const { ipcMain } = require('electron');

// Подгружаем наш IPCRouter и создаём его инстанс
const IPCRouter = require('amazing-electron-ipc-router');

// Второй аргумент не обязателен - при его отсутствии будет присовен идентификатор по умолчанию
// Для обращения к нему, в эндпоинтах следует не указывать routerId
const ipc = new IPCRouter(ipcMain, 'sampleRouterId');

// Устанавливаем хэндлер для эндпойнта
// Стоит отметить, что функция обработчика может так же быть AsyncFunction или Promise (что, в целом, одно и то же)
ipc.serve('misc/say-hi', request => {

    // Производим какие-то операции над запросом
    let greeting = `Hello, ${request.packet.body.name}!`;

    // Возвращаем ответ
    request.send(200, { greeting });

});

// Роутер может работать в обе стороны, то есть, как renderer, так и main-процессы могут обслуживать роуты и совершать запросы.
// Это пример функции, выполняющей запрос, который ожидает что-то получить в ответ
const sendCatFace = async () => {

    const result = await ipc.request('catface:sampleRouterId', { catface: '(,,◕　⋏　◕,,)' })
    console.log(result.body.message); // выведет: Thank you for this pretty catface!

};

// А вот так можно сделать запрос, который не ожидает ничего получить в ответ
ipc.emit('playback/control:sampleRouterId', { action: 'NextSong' });
```

**Renderer-процесс**
```javascript
// Получаем стандартный IPC в Electron
const { ipcRenderer } = require('electron');

// Подгружаем наш IPC и создаём его инстанс
const IPCRouter = require('amazing-electron-ipc-router');

// Второй аргумент не обязателен - при его отсутствии будет присовен идентификатор по умолчанию
// Для обращения к нему, в эндпоинтах следует не указывать routerId
const ipc = new IPCRouter(ipcRenderer, 'sampleRouterId');

// Обслуживаем эндпойнт, который принимаешь кошачьи морды с main-процесса
ipc.serve('catface', request => {

    // Выводим морду в консоль
    console.log(request.packet.body.catface);

    // Возвращаем ответ
    request.send(200, { message: 'Thank you for this pretty catface!' });

});

// Функция, тыркающая эндпойнт в main-процессе
const sayHi = async name => {

    const result = await ipc.request('misc/say-hi:sampleRouterId', { name: 'Mark' })
    console.log(result.body); // выведет: Hello, Mark!

};
```

## Как работает внутри?
Очень муторно и костыльно, но фигли делать, не хттп же сервер на локалхосте поднимать, в самом деле? Вкратце, модуль организует связь по четырём событиям (они выполняют роль, как бы, каналов / соединений):

 - `ipc-req:main` - получение входящих **запросов** от Renderer-процесса
 - `ipc-res:main` - получение ответов на запросы от Renderer-процесса
 - `ipc-req:renderer` - получение входящих запросов от Main-процесса
 - `ipc-res:renderer` - получение ответов на запросы от Main-процесса

Пакеты являются следующими структурами:
```javascript
<Request> {

    // Заголовок запроса
    _header: {

        // Уникальный идентификатор пакета (UUIDv4)
        id: String<UUID>,

        // IPC endpoint на который отправляется этот запрос
        endpoint: String,

    },

    // Тело (данные) запроса
    body: Object,

    // Функция отправки ответа
    send: Function

}

<Response> {

    // Заголовок ответа
    _header: {

        // Уникальный идентификатор пакета, на который мы отвечаем (UUIDv4)
        id: String<UUID>,

        // Статус-код ответа, в случае истечения таймаута ответа, он равен -1
        code: Number

    },

    // Тело (данные) ответа
    body: Object

}
```


## Описание API
Здесь приведено описание основных методов. Больше информации можно найти в JSDoc в самом коде.
### IPCRouter.constructor(ipc)
Конструктор класса, принимает на вход `electron.ipcMain` или `electron.ipcRenderer`.
**Пример:**
```javascript
const { ipcMain } = require('electron');
const IPC = require('amazing-electron-ipc-router');
const ipc = new IPC(ipcMain);
```

------

### IPCRouter.setWebContents(wc)
Позволяет подключить к роутеру WebContents IPC, что даёт возможность отправлять запросы из main-процесса в renderer.
**Вызывается только в main-процессе.**
**Пример:**
```javascript
const ipc = new IPC(ipcMain);
const window = new BrowserWindow(..);
ipc.setWebContents(window.webContents);
```

------

### IPCRouter.serve(endpoint, handler, [override = false])
Устанавливает обработчик для эндпойнта. В качестве первого аргумента, принимает название эндпойнта (тип `String`), а в качестве обработчика может принимать `Function` (обычные функции) или `AsyncFunction` (async-функции и Native Promises).

Параметр `override` отвечает за возможность перезаписи существующего обработчика. При стандартном значении (`false`), при попытке повторно установить обработчик для одного эндпойнта, функция выкинет ошибку. Если же, выставить параметр `override` в `true`, то повторный вызов функции переопределит обработчик на тот, который был передан при последнем вызове.

**Пример:**
```javascript
ipc.serve('test', async request => { ... });  // => true
ipc.serve('test', request => { ... })         // => throws Error, потому что override = false
ipc.serve('test', request => { ... }, true);  // => true, потому что override = true
```

------

### IPCRouter.emit(endpoint, body)
Отправляет запрос, не требующий ответа.
Принимает на вход первым аргументом имя эндпойнта (`String`), вторым - тело запроса (`Object`). Обратите внимание, что тело запроса является необходимым параметром, поэтому даже если оно пустое, то это нужно явно указать (см. пример).

**Пример:**
```javascript
ipc.emit('test', { test: '1234' });  // => true, присутствуют данные в теле запроса
ipc.emit('test', {});               // => true, тело запроса пустое
ipc.emit('test');                    // => throws Error, т.к. тело запроса явно не указано
```

------

### async IPCRouter.request(endpoint, body, [timeout = 30000])
Отправляет запрос, ожидая получить на него ответ в течении заданного времени (парметр `timeout`).
Принимает на вход первым аргументом имя эндпойнта (`String`), вторым - тело запроса (`Object`, обратите внимание, что особенность с пустым телом запроса, описанная для `IPC.emit` здесь так же справедлива), третьим - таймаут ожидания ответа в миллисекундах (`Number`, по-дефолту, равен 30000 мс, т.е. 30 секундам).

Для отключения таймаута, необходимо третьим аргументом передать ноль (`Number(0)`).

Эта функция является `AsyncFunction`, следовательно её следует использовать в конструкциях `async-await` или в Promise-chain. Она возвращает объект формата `Response` (описание структуры которого есть выше).
**Пример:**
```javascript
async () => {

    // Запрашиваем морду кота
    const freshCatFace = await ipc.request('catface/get', { emotion: 'smile' });

    // Проверяем запрос на таймаут
    if (freshCatFace.code === -1) console.error('Request timed out, no catface for today :( ');

    // Будем считать, что код 200 означает успешное выполнение запроса
    else if (freshCatFace.code === 200) console.log('Just look at this!', freshCatFace.body.packet.face);

    // Сюда свалятся другие ошибки / статусы
    else console.error(`Error ocurred during catface fetching, #${freshCatFace.code}`);
};
```

------

### Request.send([code], body)
Эта функция содержится в объекте Request, и позволяет на него чёта ответить.

Принимает на вход комбинацию статус-кода + тела ответа, или просто тела ответа (см. пример). В случае, если статус-код не указан, по-дефолту отправляется `200`.

Возвращает `Boolean(true)`, если ответ бы отправлен.

**Пример:**
```javascript
ipc.serve('test', request => {

  request.send({ meow: 'purr' }); // => true, статус-код 200
  // или
  request.send(200, { meow: 'purr' }); // => true, статус-код 200
  // или
  request.send(400, { meow: 'woof' }); // => true, статус-код 400
  // или
  request.send(200); // => throw Error, потому что не указано тело ответа

});
```

## Контрибьют, лицензия, ту-ду и прочее
Да а чёрт его знает, что здесь писать.

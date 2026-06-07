#import "/.inkycap/notebox.typ": *
#set text(lang: "fr", region: "CA")

#note(
  title: "Configurer votre boîte de notes",
  description: "Comment fonctionne une boîte de notes (un dossier portable de notes .typ accompagné d'une configuration .inkycap cachée), les trois façons d'en démarrer une, et comment organiser, ouvrir et changer de boîte de notes.",
  tags: ("documentation",),
)

= Configurer votre boîte de notes

== Ce qu'est une boîte de notes

Une *boîte de notes* est simplement un dossier sur votre ordinateur. À l'intérieur vivent vos notes (un fichier par note) aux côtés d'un petit dossier de paramètres caché qu'InkyCap entretient pour vous. Il n'y a aucune base de données ni format de fichier propriétaire pour vous enfermer : ce sont de simples fichiers sur disque, du même genre que ceux que vous pouvez copier, sauvegarder, synchroniser ou consulter avec n'importe quel outil que vous utilisez déjà.

InkyCap travaille toujours à l'intérieur d'une boîte de notes. Quand vous ouvrez l'application, vous ouvrez une boîte de notes ; tout ce que vous écrivez, reliez et organisez lui appartient.

Chaque note est un simple fichier Typst (se terminant par `.typ`). C'est ce qui rend une boîte de notes si portable. Vous pouvez ouvrir le même dossier dans n'importe quel autre outil Typst et vos notes se compileront, parce qu'InkyCap ne cache jamais votre contenu dans quelque chose que lui seul peut lire. Les informations structurées qu'InkyCap ajoute (titres, étiquettes, liens, et ainsi de suite, abordés dans #wikilink("6 - Propriétés des notes")) sont elles aussi stockées d'une façon que les autres programmes Typst peuvent lire.

#callout("note")[ Un dossier devient une boîte de notes lorsqu'InkyCap y ajoute un dossier caché `.inkycap/`. C'est par ce dossier qu'InkyCap (et tout outil coopérant) reconnaît le dossier comme une boîte de notes. ]

#callout("tip", title: "Pour les utilisatrices et utilisateurs de Typst")[ Chaque note commence par une seule ligne d'importation ajoutée automatiquement :
```typ
#import "/.inkycap/notebox.typ": *
```
Comme les propriétés de la boîte de notes sont émises sous forme de `#metadata` Typst étiquetés, vous pouvez les lire depuis l'extérieur d'InkyCap avec l'outil en ligne de commande standard (aucun processus InkyCap requis) :
```
typst query path/to/note.typ "<inkycap-note>" --field value --one
```
Les étiquettes utilisent le label `<inkycap-tag>` et les liens utilisent `<inkycap-link>`. Les chemins qu'InkyCap inscrit dans vos notes (pour les images, les fichiers de données et les bibliographies) commencent par `/`, que Typst résout par rapport à la racine de la boîte de notes, de sorte qu'ils restent corrects à mesure que les notes se déplacent. ]

== Trois façons de démarrer une boîte de notes

Vous pouvez démarrer une boîte de notes de trois façons. La première est la plus courante et est décrite en détail ci-dessous ; les deux autres sont de brefs renvois vers des pages plus complètes.

Vous trouverez les trois dans *Paramètres*, sous la section *Gestion des boîtes de notes* (voir #wikilink("2 - Paramètres")) :

+ *Nouvelle boîte de notes* crée une boîte de notes vide sur votre propre ordinateur. Partez de zéro, ou copiez vos fichiers et préférences depuis une boîte de notes que vous possédez déjà.
+ *Cloner depuis un dépôt distant* télécharge une boîte de notes existante depuis un dépôt Git partagé pour y travailler avec d'autres personnes en ligne.
+ *Importer un package* crée une boîte de notes à partir d'un fichier package qu'une collaboratrice ou un collaborateur vous a envoyé hors ligne.

=== Créer une boîte de notes toute neuve

C'est le chemin que la plupart des gens empruntent au début.

+ Ouvrez *Paramètres* et trouvez *Gestion des boîtes de notes*, ou (si aucune boîte de notes n'est encore ouverte) utilisez le bouton *Ouvrir ou créer une boîte de notes…* dans l'écran d'accueil.
+ Choisissez *Nouvelle boîte de notes*. Un sélecteur de dossier s'ouvre, à partir de votre dossier personnel.
+ Choisissez un dossier vide (ou créez-en un nouveau) où vous aimeriez que vos notes vivent, et confirmez.

C'est tout. Il n'y a pas d'étape « créer » distincte : ouvrir un dossier qui n'est pas encore une boîte de notes le transforme en boîte de notes. InkyCap ajoute discrètement le dossier caché `.inkycap/` et quelques notes de départ, et vous voilà prêt à écrire.

#callout("important")[ Une boîte de notes toute neuve *ne* vient *pas* avec une note d'accueil ou d'index. Elle démarre vide, de sorte que la première note que vous créez est réellement votre première note. ]

*Copier depuis une boîte de notes existante.* Si vous possédez déjà une autre boîte de notes et que vous pointez InkyCap vers un dossier neuf et vide, il propose d'apporter vos préférences. Vous verrez une invite *Copier depuis une boîte de notes existante ?* :

- Choisissez *Copier et ouvrir* pour reprendre vos paramètres, vos règles de création de notes, vos scaffolds (les « templates » de notes propres à InkyCap) et vos définitions de propriétés typées depuis l'une de vos autres boîtes de notes.
- Choisissez *Utiliser les valeurs par défaut* (ou appuyez sur Échap) pour repartir à neuf.

Cela copie vos *préférences*, pas vos notes. Vos notes existantes restent là où elles sont. Les chemins de fichiers absolus présents dans les paramètres copiés (comme un fichier de bibliographie ou un style de citation personnalisé) ne sont conservés que s'ils pointent toujours vers quelque chose de réel sur cet ordinateur.

=== Rejoindre une boîte de notes partagée en ligne

Si une collègue ou un collègue a déposé une boîte de notes dans un dépôt partagé, utilisez *Cloner depuis un dépôt distant* pour télécharger une copie de travail et collaborer. Vous fournirez l'adresse du dépôt et, au besoin, un nom d'utilisateur et un mot de passe. Voyez #wikilink("1 - Collaboration") pour la marche à suivre complète.

=== Rejoindre une boîte de notes partagée hors ligne

Si une collaboratrice ou un collaborateur vous a envoyé une boîte de notes sous forme de fichier package (lorsque vous n'utilisez pas de serveur partagé ou pour des raisons de confidentialité), utilisez *Importer un package*. Si le package était chiffré, on vous demandera son mot de passe. #wikilink("1 - Collaboration") couvre cela aussi.

#callout("note")[ Apporter et convertir une pile de fichiers Markdown existants est une tâche différente. Il s'agit d'*importer des notes dans une boîte de notes que vous possédez déjà*, et non de créer une boîte de notes. Voyez #wikilink("2 - Importer des notes existantes"). ]

== Organiser vos notes

À l'intérieur d'une boîte de notes, vous êtes libre d'arranger vos notes en dossiers comme bon vous semble (par sujet, par projet, par cours, ou de toute façon qui correspond à votre manière de penser). InkyCap n'impose aucune structure.

Vous gérez vos notes depuis l'*arborescence de fichiers* (l'onglet *Fichiers* dans la barre latérale de gauche). À partir de là, vous pouvez :

- Créer une nouvelle note avec le bouton *Nouvelle note* (ou appuyer sur *Ctrl+N*).
- Créer un *Nouveau dossier* pour regrouper des notes apparentées.
- Utiliser *Copier dans la boîte de notes* pour apporter des fichiers de l'extérieur.
- *Réduire tous les dossiers* ou *Développer tous les dossiers* pour épurer votre vue.
- *Trier les fichiers* pour changer leur ordre.

Le dossier caché `.inkycap/`, de même que vos templates et vos collections, est délibérément tenu à l'écart de l'arborescence de fichiers et de la recherche, afin que votre vue de tous les jours reste centrée sur vos notes réelles.

#callout("tip")[ Vous préférez des noms plus épurés ? Le paramètre *Afficher les extensions de fichiers dans l'arborescence* vous permet de masquer le `.typ` final pour que les notes apparaissent comme de simples titres. ]

== Le dossier Assets

Les images, les PDF et les autres fichiers que vous ajoutez à vos notes ont besoin d'un endroit où vivre. Par défaut, c'est un dossier nommé *Assets* à l'intérieur de votre boîte de notes. Quand vous glissez une image, en collez une ou en insérez une par la commande `/`, InkyCap la classe sous *Assets* et établit la référence pour vous automatiquement.

Vous pouvez changer l'endroit où InkyCap range ces pièces jointes. Allez dans vos *Paramètres → Fichiers*, dans le champ *Dossier des pièces jointes*. Si vous le renommez là (au moyen de *Renommer le dossier…*), InkyCap ne change pas seulement l'étiquette. Il déplace chaque fichier existant et réécrit chaque référence dans toute votre boîte de notes pour que rien ne casse.

Pendant que vous êtes dans *Paramètres → Fichiers*, vous pouvez aussi décider où les nouvelles notes sont créées par défaut :

- *Racine de la boîte de notes* est le niveau supérieur de votre boîte de notes (la valeur par défaut).
- *Dossier courant* est l'endroit où vous travaillez au moment de créer la note.
- *Dossier spécifié* est un dossier fixe que vous nommez.

== Ouvrir des boîtes de notes et en changer

Chaque fenêtre InkyCap contient *une seule boîte de notes à la fois*. La fenêtre que vous regardez porte sans ambiguïté sur une seule boîte de notes.

Pour passer à une autre boîte de notes, utilisez le *sélecteur de boîtes de notes* dans la barre d'état au bas de la fenêtre. Vos boîtes de notes connues y sont listées ; choisissez-en une pour l'ouvrir. Vous pouvez cliquer sur *Gérer les boîtes de notes…* pour en créer une autre.

Si vous préférez garder votre boîte de notes actuelle ouverte et en avoir une seconde à côté, ouvrez la nouvelle dans sa propre fenêtre :

- Utilisez *Ouvrir dans une nouvelle fenêtre* depuis la barre d'état, ou
- Appuyez sur *Ctrl+Shift+N*.

Comme chaque fenêtre possède sa propre boîte de notes, ouvrir une seconde boîte de notes dans une nouvelle fenêtre ne dérange jamais la première.

#callout("note")[ La même boîte de notes ne peut pas être ouverte dans deux fenêtres en même temps. Dans le sélecteur, une boîte de notes ouverte ailleurs apparaît grisée avec une mention *Ouverte dans une autre fenêtre*. ]

Quand vous lancez InkyCap, il rouvre la boîte de notes que vous avez utilisée en dernier. S'il n'y a rien à rouvrir, vous verrez un écran *Ouvrez une boîte de notes pour continuer* listant vos boîtes de notes. Choisissez-en une, ou créez-en une nouvelle, pour démarrer.

#callout("important")[ Retirer une boîte de notes de cette liste ne fait qu'amener InkyCap à l'oublier. Votre dossier et toutes vos notes restent bien en sécurité sur le disque ; vous pouvez toujours la rajouter plus tard. ]

== Pages connexes

- #wikilink("1 - Prise en main")
- #wikilink("2 - Paramètres")
- #wikilink("6 - Propriétés des notes")
- #wikilink("3 - Scaffolds, Templates et Packages")
- #wikilink("2 - Importer des notes existantes")
- #wikilink("1 - Collaboration")
